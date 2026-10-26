import { EventEmitter } from "node:events";
import type os from "node:os";
import packet from "dns-packet";
import { afterEach, describe, expect, it } from "vitest";
import { SERVICE_TYPE, advertisementPlan, browse, createAdvertiser, hostLabel, lanInterfaces, sameSubnet } from "./lan-advertise.mjs";
import { defaultServerConfig } from "./config.mjs";
import { cleanServerName, serverName } from "./identity.mjs";

// ---------------------------------------------------------------------------------------------
// A simulated multicast network. Every packet goes through dns-packet encode/decode, as on the wire.
// Multicast reaches every socket on the sender's /24 (including the sender: multicast loopback), or
// every socket at all when the bus is "flat" (bridged networks, or a host that loops packets back
// across adapters): responders must then filter by subnet themselves. Unicast replies reach only
// sockets on the addressed interface.

type Packet = ReturnType<typeof packet.decode>;
type Rinfo = { address: string; port: number };

class Bus {
  sockets = new Set<FakeSocket>();
  sent: Array<{ from: string; to: Rinfo | null; packet: Packet }> = [];
  failOn = new Set<string>();
  constructor(public flat = false) {}

  factory = (opts: { interface: string }) => {
    if (this.failOn.has(opts.interface)) {
      const s = new EventEmitter() as unknown as FakeSocket;
      setTimeout(() => s.emit("error", Object.assign(new Error("bind EACCES 0.0.0.0:5353"), { code: "EACCES" })), 1);
      Object.assign(s, { destroy: (cb?: () => void) => cb?.(), query() {}, respond() {} });
      return s;
    }
    return new FakeSocket(this, opts.interface, 5353);
  };

  deliver(from: FakeSocket, value: object, to: Rinfo | null) {
    const decoded = packet.decode(packet.encode(value as Parameters<typeof packet.encode>[0]));
    this.sent.push({ from: from.address, to, packet: decoded });
    for (const s of this.sockets) {
      if (to && s.address !== to.address) continue;
      if (!to && !this.flat && !sameSubnet(s.address, from.address, "255.255.255.0")) continue;
      const event = decoded.type === "query" ? "query" : "response";
      setTimeout(() => {
        if (!s.destroyed) {
          s.emit("packet", decoded, { address: from.address, port: from.port });
          s.emit(event, decoded, { address: from.address, port: from.port });
        }
      }, 0);
    }
  }

  responses(predicate: (p: Packet) => boolean = () => true) {
    return this.sent.filter((s) => s.packet.type === "response" && predicate(s.packet));
  }
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  constructor(
    private bus: Bus,
    public address: string,
    public port: number,
  ) {
    super();
    bus.sockets.add(this);
    setTimeout(() => this.emit("ready"), 0);
  }
  query(q: object, cb?: () => void) {
    this.bus.deliver(this, { ...q, type: "query" }, null);
    cb?.();
  }
  respond(res: object, rinfo?: Rinfo | (() => void), cb?: () => void): void {
    if (typeof rinfo === "function") return this.respond(res, undefined, rinfo);
    this.bus.deliver(this, { ...res, type: "response", flags: packet.AUTHORITATIVE_ANSWER }, rinfo ?? null);
    cb?.();
  }
  destroy(cb?: () => void) {
    this.destroyed = true;
    this.bus.sockets.delete(this);
    cb?.();
  }
}

const nets = (...list: Array<[string, string, string?]>): NodeJS.Dict<os.NetworkInterfaceInfo[]> =>
  Object.fromEntries(
    list.map(([name, address, netmask = "255.255.255.0"]) => [
      name,
      [{ address, netmask, family: "IPv4", mac: "00:00:00:00:00:00", internal: address.startsWith("127."), cidr: null }],
    ]),
  );

const LAN = nets(["Ethernet", "10.10.0.11"], ["VMware Network Adapter VMnet8", "192.168.86.1"], ["Loopback", "127.0.0.1"]);

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function readyConfig(patch: { allowLan?: boolean; advertise?: boolean; completed?: boolean } = {}) {
  const cfg = defaultServerConfig("C:\\data");
  cfg.server.allowLan = patch.allowLan ?? true;
  cfg.server.advertise = patch.advertise ?? true;
  cfg.setup.completed = patch.completed ?? true;
  return cfg;
}

const identity = { name: "Living Room", instanceId: "11111111-2222-4333-8444-555555555555", hostname: "JOEY-DESKTOP" };
const plan = (port = 8420, cfg = readyConfig()) => advertisementPlan(cfg, { host: "0.0.0.0", port }, identity);

/** Asks like a TV on [address] would and returns the decoded answers it received. */
async function ask(bus: Bus, address: string, questions: Array<{ name: string; type: string }>, port = 5353) {
  const tv = new FakeSocket(bus, address, port);
  const got: Packet[] = [];
  tv.on("response", (p: Packet) => got.push(p));
  await tick();
  tv.query({ questions });
  await tick(200);
  tv.destroy();
  return got;
}

/** apply() returns after the first announcement; the repeat follows announceMs later. */
async function started(a: ReturnType<typeof createAdvertiser>, p: ReturnType<typeof plan>) {
  await a.apply(p);
  await tick(120);
}

const all = (p: Packet) => [...(p.answers ?? []), ...(p.additionals ?? [])] as Array<{ name: string; type: string; ttl?: number; data: unknown }>;

const advertisers: Array<ReturnType<typeof createAdvertiser>> = [];
function advertiser(bus: Bus, interfaces = LAN, log: string[] = []) {
  const a = createAdvertiser({ mdns: bus.factory as never, interfaces: () => interfaces, probeMs: 20, announceMs: 50, rescanMs: 60_000, log: (m) => log.push(m) });
  advertisers.push(a);
  return a;
}
afterEach(async () => {
  await Promise.all(advertisers.splice(0).map((a) => a.stop()));
});

// ---------------------------------------------------------------------------------------------

describe("what is advertised", () => {
  it("only with LAN access, setup finished and advertising on", () => {
    expect(plan(8420, readyConfig({ allowLan: false }))).toEqual({ enabled: false, reason: "LAN access is off (this computer only)" });
    expect(plan(8420, readyConfig({ advertise: false }))).toEqual({ enabled: false, reason: "turned off in Settings" });
    expect(plan(8420, readyConfig({ completed: false }))).toEqual({ enabled: false, reason: "first-run setup is not finished" });
    expect(advertisementPlan(readyConfig(), { host: "127.0.0.1", port: 8420 }, identity).enabled).toBe(false);
  });

  it("the port the web server listens on, the friendly name and only non-sensitive TXT keys", () => {
    const p = plan(8430);
    expect(p).toMatchObject({ enabled: true, name: "Living Room", port: 8430, host: "notflix-joey-desktop" });
    if (!p.enabled) throw new Error("expected a plan");
    expect(p.txt).toEqual({ app: "notflix", api: "1", scheme: "http", id: identity.instanceId });
  });

  it("names are printable, dot-free DNS-SD labels; empty means the computer name", () => {
    expect(cleanServerName("  Living\u0000 Room.  ")).toBe("Living Room");
    expect(cleanServerName("a".repeat(80))).toHaveLength(60);
    expect(Buffer.byteLength(cleanServerName("é".repeat(60)), "utf8")).toBeLessThanOrEqual(63);
    const cfg = readyConfig();
    expect(serverName(cfg, "JOEY-DESKTOP")).toBe("JOEY-DESKTOP");
    cfg.server.name = "Den";
    expect(serverName(cfg, "JOEY-DESKTOP")).toBe("Den");
    expect(hostLabel("Joey's PC.lan")).toBe("notflix-joey-s-pc-lan");
  });

  it("LAN interfaces skip loopback and link-local; a bound address limits them to one", () => {
    const n = nets(["Ethernet", "10.10.0.11"], ["Wi-Fi", "169.254.3.4"], ["Loopback", "127.0.0.1"], ["VMnet8", "192.168.86.1"]);
    expect(lanInterfaces("0.0.0.0", n).map((i) => i.address)).toEqual(["10.10.0.11", "192.168.86.1"]);
    expect(lanInterfaces("10.10.0.11", n).map((i) => i.address)).toEqual(["10.10.0.11"]);
    expect(sameSubnet("10.10.0.50", "10.10.0.11", "255.255.255.0")).toBe(true);
    expect(sameSubnet("10.10.1.50", "10.10.0.11", "255.255.255.0")).toBe(false);
    expect(sameSubnet("10.10.1.50", "10.10.0.11", "255.255.0.0")).toBe(true);
  });
});

describe("responder", () => {
  it("answers a TV's browse with the configured port and the address of the TV's own network", async () => {
    const bus = new Bus();
    const a = advertiser(bus);
    await started(a, plan(8420));
    expect(a.status()).toMatchObject({ active: true, name: "Living Room", port: 8420, addresses: ["10.10.0.11", "192.168.86.1"] });

    const answers = await ask(bus, "10.10.0.50", [{ name: SERVICE_TYPE, type: "PTR" }]);
    expect(answers).toHaveLength(1); // only the Ethernet responder answers a 10.10.0.x question
    const records = all(answers[0]);
    expect(records.find((r) => r.type === "PTR")?.data).toBe(`Living Room.${SERVICE_TYPE}`);
    expect(records.find((r) => r.type === "SRV")?.data).toMatchObject({ port: 8420, target: "notflix-joey-desktop.local" });
    expect(records.filter((r) => r.type === "A").map((r) => r.data)).toEqual(["10.10.0.11"]);
    const txt = (records.find((r) => r.type === "TXT")?.data as Buffer[]).map((b) => b.toString());
    expect(txt.sort()).toEqual(["api=1", "app=notflix", `id=${identity.instanceId}`, "scheme=http"]);
    // Nothing that looks like a credential, account, path or the engine port.
    expect(JSON.stringify(txt)).not.toMatch(/token|key|secret|password|user|8421|[A-Z]:\\/i);

    const vm = await ask(bus, "192.168.86.128", [{ name: SERVICE_TYPE, type: "PTR" }]);
    expect(all(vm[0]).filter((r) => r.type === "A").map((r) => r.data)).toEqual(["192.168.86.1"]);
  });

  it("resolves SRV, TXT and A questions individually and ignores other services", async () => {
    const bus = new Bus();
    const a = advertiser(bus);
    await started(a, plan(8420));
    const srv = await ask(bus, "10.10.0.50", [{ name: `Living Room.${SERVICE_TYPE}`, type: "SRV" }]);
    expect(srv[0].answers?.map((r) => r.type)).toEqual(["SRV"]);
    expect(srv[0].additionals?.map((r) => r.type)).toEqual(["A"]);
    const host = await ask(bus, "10.10.0.50", [{ name: "notflix-joey-desktop.local", type: "A" }]);
    expect(host[0].answers?.[0]).toMatchObject({ type: "A", data: "10.10.0.11" });
    expect(await ask(bus, "10.10.0.50", [{ name: "_http._tcp.local", type: "PTR" }])).toHaveLength(0);
  });

  it("on a flat network, each interface still only answers questions from its own subnet", async () => {
    const bus = new Bus(true);
    const a = advertiser(bus);
    await started(a, plan(8420));
    const answers = await ask(bus, "10.10.0.50", [{ name: SERVICE_TYPE, type: "PTR" }]);
    expect(answers.flatMap((p) => all(p).filter((r) => r.type === "A").map((r) => r.data))).toEqual(["10.10.0.11"]);
    expect(await ask(bus, "172.16.5.5", [{ name: SERVICE_TYPE, type: "PTR" }])).toHaveLength(0);
  });

  it("answers a legacy unicast query directly, with the question echoed and short TTLs", async () => {
    const bus = new Bus();
    const a = advertiser(bus);
    await started(a, plan(8420));
    const got = await ask(bus, "10.10.0.50", [{ name: SERVICE_TYPE, type: "PTR" }], 53123);
    expect(got).toHaveLength(1);
    expect(got[0].questions?.[0]?.name).toBe(SERVICE_TYPE);
    expect(Math.max(...all(got[0]).map((r) => r.ttl ?? 0))).toBeLessThanOrEqual(10);
    expect(bus.responses().at(-1)?.to).toMatchObject({ address: "10.10.0.50", port: 53123 });
  });

  it("follows a port change: goodbye for the old port, then the new one", async () => {
    const bus = new Bus();
    const a = advertiser(bus);
    await started(a, plan(8420));
    bus.sent.length = 0;
    await a.apply(plan(8430));
    const goodbyes = bus.responses((p) => all(p).some((r) => r.type === "SRV" && r.ttl === 0));
    expect(goodbyes.length).toBeGreaterThan(0);
    expect((all(goodbyes[0].packet).find((r) => r.type === "SRV")?.data as { port: number }).port).toBe(8420);
    const answers = await ask(bus, "10.10.0.50", [{ name: SERVICE_TYPE, type: "PTR" }]);
    expect((all(answers[0]).find((r) => r.type === "SRV")?.data as { port: number }).port).toBe(8430);
    expect(a.status()).toMatchObject({ active: true, port: 8430 });
  });

  it("applying the same plan again changes nothing (no duplicate announcements)", async () => {
    const bus = new Bus();
    const a = advertiser(bus);
    await started(a, plan(8420));
    await tick(80);
    bus.sent.length = 0;
    await started(a, plan(8420));
    await tick(80);
    expect(bus.sent).toHaveLength(0);
  });

  it("stops answering and says goodbye when Notflix stops or LAN access is turned off", async () => {
    const bus = new Bus();
    const a = advertiser(bus);
    await started(a, plan(8420));
    await a.apply(plan(8420, readyConfig({ allowLan: false })));
    expect(bus.responses((p) => all(p).some((r) => r.ttl === 0)).length).toBeGreaterThan(0);
    expect(a.status()).toMatchObject({ active: false, reason: "LAN access is off (this computer only)" });
    expect(await ask(bus, "10.10.0.50", [{ name: SERVICE_TYPE, type: "PTR" }])).toHaveLength(0);
    expect(bus.sockets.size).toBe(0); // no socket left open while not advertising

    await started(a, plan(8420));
    await a.stop();
    expect(a.status()).toMatchObject({ active: false, reason: "Notflix stopped" });
    expect(await ask(bus, "10.10.0.50", [{ name: SERVICE_TYPE, type: "PTR" }])).toHaveLength(0);
    expect(bus.sockets.size).toBe(0);
  });

  it("two servers with the same name: the second one renames itself, both are found with their own ports", async () => {
    const bus = new Bus();
    const log: string[] = [];
    const first = advertiser(bus);
    await started(first, plan(8420));
    const second = advertiser(bus, nets(["Ethernet", "10.10.0.12"]), log);
    await started(second, advertisementPlan(readyConfig(), { host: "0.0.0.0", port: 8519 }, { ...identity, hostname: "OTHER-PC", instanceId: "other" }));
    expect(second.status().name).toBe("Living Room (2)");
    expect(log.join("\n")).toMatch(/already used/);

    const answers = await ask(bus, "10.10.0.50", [{ name: SERVICE_TYPE, type: "PTR" }]);
    const services = answers.flatMap((p) => all(p).filter((r) => r.type === "SRV")).map((r) => [r.name, (r.data as { port: number }).port]);
    expect(services.sort()).toEqual([
      [`Living Room (2).${SERVICE_TYPE}`, 8519],
      [`Living Room.${SERVICE_TYPE}`, 8420],
    ]);
  });

  it("keeps the website independent: no usable interface or a failing socket is reported, never thrown", async () => {
    const bus = new Bus();
    const none = advertiser(bus, nets(["Loopback", "127.0.0.1"]));
    await expect(none.apply(plan(8420))).resolves.toBeUndefined();
    expect(none.status()).toMatchObject({ active: false, error: "no network connection with an IPv4 address" });

    bus.failOn.add("10.10.0.11");
    const failing = advertiser(bus, nets(["Ethernet", "10.10.0.11"]));
    await failing.apply(plan(8420));
    expect(failing.status().active).toBe(false);
    expect(failing.status().error).toMatch(/mDNS is unavailable on Ethernet .*EACCES/);
  });

  it("browse() lists announced servers the way the launcher's status check sees them", async () => {
    const bus = new Bus();
    await started(advertiser(bus), plan(8420));
    const found = await browse({ mdns: bus.factory as never, interfaces: [{ name: "Ethernet", address: "10.10.0.11", netmask: "255.255.255.0" }], timeoutMs: 400 });
    expect(found).toEqual([
      expect.objectContaining({ name: "Living Room", port: 8420, addresses: ["10.10.0.11"], via: ["Ethernet"], txt: expect.objectContaining({ id: identity.instanceId }) }),
    ]);
  });
});
