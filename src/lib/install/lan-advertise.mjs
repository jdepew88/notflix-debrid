// LAN discovery: announces this Notflix server with mDNS / DNS-SD (service type _notflix._tcp) so the
// Android TV app and other clients find it without typing an address. Runs inside server.mjs, so
// it starts and stops with the web server and follows port / LAN-access changes.
//
// What is announced: the friendly name, the web app/API port the server actually listens on, a
// host name with the address of the interface the question arrived on, and a TXT record with
// app=notflix, api=<version>, scheme=http and the random instance ID. Never the media engine, never
// credentials, account names or paths. Clients must still verify GET /api/health before trusting it.
//
// One small responder per LAN interface (multicast-dns), each answering only questions from its own
// subnet with its own address: a PC with VPN/VMware/WSL adapters never hands a TV an address it
// can't reach. Probing renames the service ("Name (2)") when another server already uses the name;
// a clean stop sends goodbye packets so clients drop the entry at once (after a crash the records
// expire with their 2-minute TTL).
import os from "node:os";
import multicastDns from "multicast-dns";
import { API_VERSION } from "./identity.mjs";

export const SERVICE_TYPE = "_notflix._tcp.local";
const SERVICES_META = "_services._dns-sd._udp.local";
const TTL = 120;
const LEGACY_TTL = 10;
const MAX_RENAMES = 9;

/** @typedef {{ name: string, address: string, netmask: string }} LanInterface */
/**
 * @typedef {{ enabled: false, reason: string } | {
 *   enabled: true, name: string, port: number, bindHost: string, host: string, txt: Record<string, string>
 * }} AdvertisementPlan
 */
/**
 * @typedef {object} AdvertisementStatus
 * @property {boolean} active  answering on at least one interface
 * @property {string} serviceType
 * @property {string | null} name  the instance name in use (may carry a " (2)" suffix)
 * @property {number | null} port
 * @property {string | null} host
 * @property {string[]} addresses
 * @property {string | null} reason  why nothing is advertised, when inactive by choice
 * @property {string | null} error  why advertising failed, when it should be active
 * @property {string} since
 */

const toInt = (/** @type {string} */ ip) => ip.split(".").reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);

/** @param {string} a @param {string} b @param {string} netmask */
export function sameSubnet(a, b, netmask) {
  const m = toInt(netmask);
  return ((toInt(a) & m) >>> 0) === ((toInt(b) & m) >>> 0);
}

/**
 * IPv4 interfaces other devices may reach the server on. Loopback and link-local (169.254.x, no
 * DHCP) are skipped; a server bound to one address is only announced on that interface.
 * @param {string} bindHost  the address the web server listens on
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [nets]
 * @returns {LanInterface[]}
 */
export function lanInterfaces(bindHost, nets = os.networkInterfaces()) {
  /** @type {LanInterface[]} */
  const out = [];
  const specific = bindHost && bindHost !== "0.0.0.0" && bindHost !== "::" ? bindHost : null;
  for (const [name, list] of Object.entries(nets)) {
    for (const n of list ?? []) {
      if ((n.family !== "IPv4" && /** @type {unknown} */ (n.family) !== 4) || n.internal || n.address.startsWith("169.254.")) continue;
      if (specific && n.address !== specific) continue;
      if (!out.some((o) => o.address === n.address)) out.push({ name, address: n.address, netmask: n.netmask });
    }
  }
  return out;
}

/**
 * mDNS host label for the SRV target. Not the bare computer name: Windows and macOS already answer
 * for <computer>.local themselves (with every adapter's address), and two responders must not
 * claim one name with different data.
 * @param {string} hostname
 */
export function hostLabel(hostname) {
  const base = hostname.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 54);
  return `notflix-${base || "server"}`;
}

/** @param {string} host */
const isLoopbackHost = (host) => host === "localhost" || host === "::1" || host.startsWith("127.");

/**
 * What to announce for this configuration and listening address, or why nothing.
 * @param {import("./config.mjs").ServerConfig} cfg
 * @param {{ host: string, port: number }} listening  where server.mjs is actually listening
 * @param {{ name: string, instanceId: string, hostname?: string }} identity
 * @returns {AdvertisementPlan}
 */
export function advertisementPlan(cfg, listening, identity) {
  if (!cfg.server.advertise) return { enabled: false, reason: "turned off in Settings" };
  if (!cfg.server.allowLan || isLoopbackHost(listening.host)) return { enabled: false, reason: "LAN access is off (this computer only)" };
  if (!cfg.setup.completed) return { enabled: false, reason: "first-run setup is not finished" };
  return {
    enabled: true,
    name: identity.name,
    port: listening.port,
    bindHost: listening.host,
    host: hostLabel(identity.hostname ?? os.hostname()),
    txt: { app: "notflix", api: String(API_VERSION), scheme: "http", id: identity.instanceId },
  };
}

/** "Living Room" → "Living Room (2)", kept within the 63-byte DNS label limit. */
function withSuffix(/** @type {string} */ base, /** @type {number} */ n) {
  const suffix = ` (${n})`;
  let b = base;
  while (Buffer.byteLength(b + suffix, "utf8") > 63) b = [...b].slice(0, -1).join("");
  return b.trimEnd() + suffix;
}

const lower = (/** @type {unknown} */ s) => String(s).toLowerCase();
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms).unref?.());

/**
 * @param {{
 *   log?: (message: string) => void,
 *   onStatus?: (status: AdvertisementStatus) => void,
 *   mdns?: typeof multicastDns,
 *   interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>,
 *   rescanMs?: number,
 *   probeMs?: number,
 *   announceMs?: number,
 * }} [opts]
 */
export function createAdvertiser(opts = {}) {
  const log = opts.log ?? (() => {});
  const onStatus = opts.onStatus ?? (() => {});
  const mdns = opts.mdns ?? multicastDns;
  const interfaces = opts.interfaces ?? (() => os.networkInterfaces());
  const probeMs = opts.probeMs ?? 250;
  const announceMs = opts.announceMs ?? 1000;

  /** @typedef {{ iface: LanInterface, m: ReturnType<typeof multicastDns>, lastMulticast: Map<string, number> }} Responder */
  /** @type {Map<string, Responder>} keyed by interface address */
  const responders = new Map();
  /** @type {Extract<AdvertisementPlan, { enabled: true }> | null} */
  let plan = null;
  /** @type {string | null} */
  let name = null;
  /** @type {"off" | "probing" | "announced"} */
  let phase = "off";
  let conflict = false;
  /** @type {string | null} */
  let reason = "not started";
  /** @type {string | null} */
  let error = null;
  let since = new Date().toISOString();
  let stopped = false;
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  /** @type {Set<NodeJS.Timeout>} */
  const timers = new Set();

  // Network changes (DHCP renewals, Wi-Fi reconnects, a cable plugged in after start).
  const rescan = setInterval(() => {
    if (!plan || stopped || phase === "probing") return;
    queue(async () => {
      if (!plan || stopped) return;
      if (phase === "announced") await syncInterfaces();
      else if (phase === "off") {
        await syncInterfaces();
        if (responders.size > 0) await probeAndAnnounce();
      }
    });
  }, opts.rescanMs ?? 30_000);
  rescan.unref?.();

  /** @returns {AdvertisementStatus} */
  function status() {
    return {
      active: phase === "announced" && responders.size > 0,
      serviceType: SERVICE_TYPE,
      name: phase === "announced" ? name : null,
      port: plan?.port ?? null,
      host: plan ? `${plan.host}.local` : null,
      addresses: phase === "announced" ? [...responders.keys()] : [],
      reason,
      error,
      since,
    };
  }

  function publish() {
    since = new Date().toISOString();
    try {
      onStatus(status());
    } catch {
      /* status reporting must never break advertising */
    }
  }

  /** @param {() => Promise<void>} task */
  function queue(task) {
    chain = chain.then(task).catch((err) => {
      error = err instanceof Error ? err.message : String(err);
      log(`LAN advertisement error: ${error}`);
      publish();
    });
    return chain;
  }

  /** @param {Responder} r @param {number} [ttl] */
  function records(r, ttl = TTL) {
    if (!plan || !name) throw new Error("nothing to advertise");
    const instance = `${name}.${SERVICE_TYPE}`;
    const host = `${plan.host}.local`;
    return {
      ptr: { name: SERVICE_TYPE, type: "PTR", ttl, data: instance },
      meta: { name: SERVICES_META, type: "PTR", ttl, data: SERVICE_TYPE },
      srv: { name: instance, type: "SRV", ttl, flush: true, data: { port: plan.port, target: host, priority: 0, weight: 0 } },
      // A fresh array each time: dns-packet converts the strings to Buffers in place.
      txt: { name: instance, type: "TXT", ttl, flush: true, data: Object.entries(plan.txt).map(([k, v]) => `${k}=${v}`) },
      a: { name: host, type: "A", ttl, flush: true, data: r.iface.address },
    };
  }

  /**
   * Sends a response (multicast, or unicast to [to]); a packet with type "query" is sent as a query.
   * Resolves once handed to the OS, or after 500 ms at the latest.
   * @param {Responder} r @param {any} packet @param {{ address: string, port: number }} [to]
   */
  function send(r, packet, to) {
    return new Promise((resolve) => {
      const done = setTimeout(resolve, 500);
      const sent = () => {
        clearTimeout(done);
        resolve(undefined);
      };
      try {
        if (packet.type === "query") r.m.query(packet, sent);
        else r.m.respond(packet, /** @type {any} */ (to), sent);
      } catch {
        sent();
      }
    });
  }

  /** @param {Responder} r @param {any} packet @param {{ address: string, port: number }} rinfo */
  function onQuery(r, packet, rinfo) {
    if (phase !== "announced" || !sameSubnet(rinfo.address, r.iface.address, r.iface.netmask)) return;
    const rec = records(r);
    const answers = new Set();
    const extra = new Set();
    for (const q of packet.questions ?? []) {
      const qn = lower(q.name);
      const any = q.type === "ANY";
      if (qn === lower(SERVICE_TYPE) && (q.type === "PTR" || any)) {
        answers.add(rec.ptr);
        extra.add(rec.srv).add(rec.txt).add(rec.a);
      } else if (qn === SERVICES_META && (q.type === "PTR" || any)) {
        answers.add(rec.meta);
      } else if (qn === lower(rec.srv.name)) {
        if (q.type === "SRV" || any) {
          answers.add(rec.srv);
          extra.add(rec.a);
        }
        if (q.type === "TXT" || any) answers.add(rec.txt);
      } else if (qn === lower(rec.a.name) && (q.type === "A" || any)) {
        answers.add(rec.a);
      }
    }
    // Known-answer suppression: the asker already has a fresh copy of the PTR record.
    for (const known of packet.answers ?? []) {
      if (known.type === "PTR" && lower(known.name) === lower(rec.ptr.name) && lower(known.data) === lower(rec.ptr.data) && known.ttl > TTL / 2) {
        answers.delete(rec.ptr);
      }
    }
    if (answers.size === 0) return;
    for (const a of answers) extra.delete(a);

    if (rinfo.port !== 5353) {
      // Legacy unicast query (a plain DNS client asking 224.0.0.251): answer it directly, echoing
      // the question, with short TTLs and no cache-flush bit.
      const legacy = (/** @type {any} */ x) => ({ ...x, ttl: Math.min(x.ttl, LEGACY_TTL), flush: false });
      void send(r, { id: packet.id, questions: packet.questions, answers: [...answers].map(legacy), additionals: [...extra].map(legacy) }, rinfo);
      return;
    }
    // Multicast answer (also for QU questions, which RFC 6762 permits), at most once per second per
    // record and interface. A probe (another server checking whether our name is free) is always
    // answered, at once; so are questions only about our own unique records. Answers that include
    // the shared PTR record wait 20-120 ms so several responders don't collide.
    const probe = (packet.authorities ?? []).length > 0;
    const now = Date.now();
    const fresh = probe ? [...answers] : [...answers].filter((a) => now - (r.lastMulticast.get(`${a.type} ${lower(a.name)}`) ?? 0) >= 1000);
    if (fresh.length === 0) return;
    for (const a of fresh) r.lastMulticast.set(`${a.type} ${lower(a.name)}`, now);
    const shared = fresh.some((a) => a.type === "PTR");
    const t = setTimeout(() => {
      timers.delete(t);
      if (phase === "announced") void send(r, { answers: fresh, additionals: [...extra] });
    }, shared && !probe ? 20 + Math.floor(Math.random() * 100) : 0);
    t.unref?.();
    timers.add(t);
  }

  /** Another responder answering for our instance name with different data is a name conflict. */
  function onResponse(/** @type {any} */ packet) {
    if (!plan || !name || phase === "off") return;
    const instance = lower(`${name}.${SERVICE_TYPE}`);
    const ours = `${plan.host}.local`;
    for (const rec of [...(packet.answers ?? []), ...(packet.additionals ?? [])]) {
      if (rec.type !== "SRV" || rec.ttl === 0 || lower(rec.name) !== instance) continue;
      if (rec.data?.port === plan.port && lower(rec.data?.target) === ours) continue; // ours, or an identical copy
      if (phase === "probing") conflict = true;
      else if (phase === "announced") {
        log(`Another server on the network now uses the name "${name}"; choosing another`);
        phase = "probing";
        queue(probeAndAnnounce);
      }
      return;
    }
  }

  /** @param {LanInterface} iface @returns {Promise<Responder | null>} */
  function open(iface) {
    return new Promise((resolve) => {
      let settled = false;
      /** @type {Responder} */
      let r;
      const finish = (/** @type {Responder | null} */ value, /** @type {string} */ problem = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (!value) {
          error = `mDNS is unavailable on ${iface.name} (${iface.address}): ${problem}`;
          log(`LAN advertisement: ${error}`);
          try {
            m.destroy();
          } catch {
            /* ignore */
          }
        }
        resolve(value);
      };
      const timeout = setTimeout(() => finish(null, "timed out opening UDP port 5353"), 3000);
      // Every responder binds 0.0.0.0:5353 (shared with the system's own mDNS service), joins the
      // group on its interface and sends through it.
      /** @type {ReturnType<typeof multicastDns>} */
      let m;
      try {
        m = mdns({ interface: iface.address, bind: "0.0.0.0", reuseAddr: true, loopback: true });
      } catch (err) {
        clearTimeout(timeout);
        error = `mDNS is unavailable on ${iface.name} (${iface.address}): ${err instanceof Error ? err.message : err}`;
        log(`LAN advertisement: ${error}`);
        resolve(null);
        return;
      }
      r = { iface, m, lastMulticast: new Map() };
      m.on("ready", () => finish(r));
      m.on("error", (/** @type {Error} */ err) => finish(null, err.message));
      m.on("warning", () => {}); // malformed packets from other devices are not our problem
      m.on("query", (/** @type {any} */ q, /** @type {any} */ rinfo) => onQuery(r, q, rinfo));
      m.on("response", (/** @type {any} */ res) => onResponse(res));
    });
  }

  /** @param {Responder} r */
  async function close(r) {
    responders.delete(r.iface.address);
    await new Promise((resolve) => {
      try {
        r.m.destroy(() => resolve(undefined));
      } catch {
        resolve(undefined);
      }
    });
  }

  /** @param {Responder} r */
  async function goodbye(r) {
    const rec = records(r, 0);
    await send(r, { answers: [rec.ptr, rec.srv, rec.txt, rec.a] });
  }

  /** @param {Responder} r */
  async function announce(r) {
    const rec = records(r);
    await send(r, { answers: [rec.ptr, rec.meta, rec.srv, rec.txt, rec.a] });
  }

  /** Opens responders for new interfaces and closes those whose address went away. */
  async function syncInterfaces() {
    if (!plan) return;
    const wanted = lanInterfaces(plan.bindHost, interfaces());
    const before = responders.size;
    for (const r of [...responders.values()]) {
      const still = wanted.find((w) => w.address === r.iface.address && w.netmask === r.iface.netmask);
      if (!still) {
        if (phase === "announced") await goodbye(r).catch(() => {});
        await close(r);
      }
    }
    let changed = responders.size !== before;
    const added = [];
    for (const iface of wanted) {
      if (responders.has(iface.address)) continue;
      const r = await open(iface);
      if (r) {
        responders.set(iface.address, r);
        added.push(r);
        changed = true;
      }
    }
    if (wanted.length === 0) error = "no network connection with an IPv4 address";
    else if (responders.size > 0) error = null;
    if (phase === "announced" && changed) {
      for (const r of added) await announce(r);
      log(`LAN advertisement now on ${[...responders.keys()].join(", ") || "no interface"}`);
      publish();
    }
  }

  async function probeAndAnnounce() {
    if (!plan || stopped) return;
    const base = plan.name;
    for (let attempt = 1; attempt <= MAX_RENAMES + 1; attempt++) {
      name = attempt === 1 ? base : withSuffix(base, attempt);
      phase = "probing";
      conflict = false;
      const instance = `${name}.${SERVICE_TYPE}`;
      for (let i = 0; i < 3 && !conflict; i++) {
        for (const r of responders.values()) {
          const rec = records(r);
          void send(r, { type: "query", questions: [{ name: instance, type: "ANY" }], authorities: [rec.srv, rec.txt] });
        }
        await sleep(probeMs);
      }
      if (!conflict) await sleep(probeMs);
      if (!conflict) break;
      log(`The name "${name}" is already used by another Notflix server on the network`);
      if (attempt === MAX_RENAMES + 1) {
        phase = "off";
        error = `no free name found after ${attempt} attempts`;
        publish();
        return;
      }
    }
    if (stopped || !plan) return;
    phase = "announced";
    reason = null;
    for (const r of responders.values()) await announce(r);
    // RFC 6762 §8.3: announce at least twice, one second apart.
    const again = setTimeout(() => {
      timers.delete(again);
      if (phase === "announced") for (const r of responders.values()) void announce(r);
    }, announceMs);
    again.unref?.();
    timers.add(again);
    log(`Advertising ${SERVICE_TYPE.replace(/\.local$/, "")} "${name}" on port ${plan.port} at ${[...responders.keys()].join(", ")} (host ${plan.host}.local)`);
    publish();
  }

  /** Stops answering and tells clients to forget the service; closes every socket. */
  async function withdraw() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    const was = phase;
    phase = "off";
    for (const r of [...responders.values()]) {
      if (was === "announced") await goodbye(r).catch(() => {});
      await close(r);
    }
    plan = null;
    name = null;
  }

  /** @param {AdvertisementPlan} next */
  async function doApply(next) {
    if (stopped) return;
    if (!next.enabled) {
      const had = phase !== "off";
      await withdraw();
      error = null;
      if (had || reason !== next.reason) {
        reason = next.reason;
        log(`Not advertising on the local network: ${next.reason}`);
        publish();
      }
      return;
    }
    if (plan && phase !== "off" && JSON.stringify(plan) === JSON.stringify(next)) return;
    if (phase === "announced") log(`LAN advertisement changing (${plan?.port} → ${next.port}${plan?.name !== next.name ? `, "${next.name}"` : ""})`);
    await withdraw();
    plan = next;
    reason = null;
    await syncInterfaces();
    if (responders.size === 0) {
      error ??= "no network interface could be used";
      log(`Not advertising on the local network: ${error}. Devices can still connect by address.`);
      publish();
      return;
    }
    await probeAndAnnounce();
  }

  return {
    /** Advertise according to [next] (idempotent). Never throws. @param {AdvertisementPlan} next */
    apply(next) {
      return queue(() => doApply(next));
    },
    /** Goodbye packets, then every socket closed. Safe to call twice. */
    stop() {
      clearInterval(rescan);
      return queue(async () => {
        if (stopped) return;
        stopped = true;
        const was = phase;
        await withdraw();
        reason = "Notflix stopped";
        if (was === "announced") log("Stopped advertising on the local network");
        publish();
      });
    },
    status,
  };
}

/**
 * Asks the network who offers _notflix._tcp and collects the answers (diagnostics and tests; the
 * launcher's status check uses it). One entry per service; a server answering on several of this
 * computer's networks lists every address, and [via] names the local interfaces that heard it.
 * @param {{ timeoutMs?: number, interfaces?: LanInterface[], mdns?: typeof multicastDns }} [opts]
 * @returns {Promise<Array<{ name: string, host: string | null, port: number | null, addresses: string[], txt: Record<string, string>, via: string[] }>>}
 */
export async function browse(opts = {}) {
  const mdns = opts.mdns ?? multicastDns;
  const ifaces = opts.interfaces ?? lanInterfaces("");
  /** @type {Map<string, { name: string, host: string | null, port: number | null, addresses: string[], txt: Record<string, string>, via: string[] }>} */
  const found = new Map();
  const sockets = [];
  for (const iface of ifaces) {
    const m = mdns({ interface: iface.address, bind: "0.0.0.0", reuseAddr: true, loopback: true });
    m.on("error", () => {});
    m.on("warning", () => {});
    m.on("response", (/** @type {any} */ res, /** @type {any} */ rinfo) => {
      // Only answers from this interface's own network (a host may loop back other adapters' packets).
      if (!sameSubnet(rinfo.address, iface.address, iface.netmask)) return;
      const all = [...(res.answers ?? []), ...(res.additionals ?? [])];
      for (const ptr of all.filter((x) => x.type === "PTR" && lower(x.name) === lower(SERVICE_TYPE) && x.ttl > 0)) {
        const instance = String(ptr.data);
        const key = lower(instance);
        const entry = found.get(key) ?? { name: instance.replace(/\._notflix\._tcp\.local$/i, ""), host: null, port: null, addresses: [], txt: {}, via: [] };
        if (!entry.via.includes(iface.name)) entry.via.push(iface.name);
        const srv = all.find((x) => x.type === "SRV" && lower(x.name) === lower(instance));
        if (srv) {
          entry.host = srv.data.target;
          entry.port = srv.data.port;
          for (const a of all.filter((x) => x.type === "A" && lower(x.name) === lower(srv.data.target))) {
            if (!entry.addresses.includes(a.data)) entry.addresses.push(a.data);
          }
        }
        const txt = all.find((x) => x.type === "TXT" && lower(x.name) === lower(instance));
        for (const b of txt?.data ?? []) {
          const s = Buffer.from(b).toString("utf8");
          const i = s.indexOf("=");
          if (i > 0) entry.txt[s.slice(0, i)] = s.slice(i + 1);
        }
        found.set(key, entry);
      }
    });
    m.on("ready", () => m.query({ questions: [{ name: SERVICE_TYPE, type: "PTR" }] }));
    sockets.push(m);
  }
  await sleep(opts.timeoutMs ?? 1500);
  for (const m of sockets) {
    try {
      m.destroy();
    } catch {
      /* ignore */
    }
  }
  return [...found.values()];
}
