/**
 * Standards-based Web Push with Node's crypto only (no third-party push provider or library):
 * - VAPID (RFC 8292): the server signs a short-lived ES256 JWT for the push service's origin;
 * - message encryption (RFC 8291, "aes128gcm" content coding, RFC 8188): only the subscribed
 *   browser can read the payload; the push service (Google, Mozilla, Apple, Microsoft) relays
 *   opaque bytes.
 * The VAPID private key lives in the encrypted credential store (secrets.json); only the public key
 * is ever sent to browsers.
 */
import crypto from "node:crypto";

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

export interface VapidKeys {
  /** Uncompressed P-256 point (65 bytes), base64url: the browser's applicationServerKey. */
  publicKey: string;
  /** Private scalar d (32 bytes), base64url. */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(pub.x!), fromB64u(pub.y!)])),
    privateKey: priv.d!,
  };
}

export function validVapidKeys(k: Partial<VapidKeys> | null | undefined): k is VapidKeys {
  try {
    if (!k?.publicKey || !k.privateKey) return false;
    const pub = fromB64u(k.publicKey);
    if (pub.length !== 65 || pub[0] !== 4 || fromB64u(k.privateKey).length !== 32) return false;
    privateKeyObject(k as VapidKeys);
    return true;
  } catch {
    return false;
  }
}

function privateKeyObject(keys: VapidKeys): crypto.KeyObject {
  const pub = fromB64u(keys.publicKey);
  return crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: keys.privateKey },
    format: "jwk",
  });
}

/** `Authorization` header value for one push service origin (valid 12 hours). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), { key: privateKeyObject(keys), dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

const hmac = (key: Buffer, data: Buffer) => crypto.createHmac("sha256", key).update(data).digest();

/**
 * Encrypts a payload for one subscription (RFC 8291 §3.4, single record). `salt` and `serverKeys`
 * are parameters only so tests can be deterministic; normally both are fresh per message.
 */
export function encryptPayload(
  payload: Buffer,
  subscription: { p256dh: string; auth: string },
  opts: { salt?: Buffer; serverKeys?: crypto.ECDH } = {}
): Buffer {
  const uaPublic = fromB64u(subscription.p256dh);
  const authSecret = fromB64u(subscription.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("Invalid subscription key");
  if (authSecret.length < 16) throw new Error("Invalid subscription auth secret");
  const ecdh = opts.serverKeys ?? crypto.createECDH("prime256v1");
  if (!opts.serverKeys) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? crypto.randomBytes(16);

  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "binary")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "binary")).subarray(0, 12);

  const rs = 4096;
  if (payload.length + 1 + 16 > rs) throw new Error("Push payload too large");
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02: delimiter of the last (only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** Inverse of encryptPayload, as a browser does it (tests and diagnostics). */
export function decryptPayload(message: Buffer, ua: { ecdh: crypto.ECDH; auth: Buffer }): Buffer {
  const salt = message.subarray(0, 16);
  const idlen = message.readUInt8(20);
  const asPublic = message.subarray(21, 21 + idlen);
  const body = message.subarray(21 + idlen);
  const uaPublic = ua.ecdh.getPublicKey();
  const shared = ua.ecdh.computeSecret(asPublic);
  const prkKey = hmac(ua.auth, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "binary")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "binary")).subarray(0, 12);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  const end = plain.lastIndexOf(2);
  return plain.subarray(0, end);
}

/** Verifies a VAPID header against the public key (tests and the fake push service). */
export function verifyVapid(authorization: string, endpoint: string, now = Date.now()): { ok: boolean; publicKey?: string; sub?: string } {
  const m = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!m) return { ok: false };
  const [h, c, s] = m[1].split(".");
  const pub = fromB64u(m[2]);
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: "jwk" });
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, fromB64u(s));
  const claims = JSON.parse(fromB64u(c).toString("utf8")) as { aud: string; exp: number; sub: string };
  return { ok: ok && claims.aud === new URL(endpoint).origin && claims.exp * 1000 > now, publicKey: m[2], sub: claims.sub };
}

export interface PushMessage {
  title: string;
  body: string;
  /** Same-origin path opened on click. */
  url: string;
  /** Replaces an earlier notification with the same tag instead of stacking. */
  tag: string;
  icon?: string;
}

export interface PushResult {
  ok: boolean;
  /** The subscription no longer exists (404/410): remove it. */
  gone: boolean;
  status: number;
}

/** Sends one encrypted message. Never throws for HTTP errors; network errors count as failures. */
export async function sendPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  message: PushMessage,
  keys: VapidKeys,
  opts: { subject: string; fetchImpl?: typeof fetch; ttlSeconds?: number; urgency?: "low" | "normal" | "high" } = { subject: "" }
): Promise<PushResult> {
  const body = encryptPayload(Buffer.from(JSON.stringify(message)), subscription);
  try {
    const res = await (opts.fetchImpl ?? fetch)(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorization(subscription.endpoint, keys, opts.subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(opts.ttlSeconds ?? 24 * 3600),
        Urgency: opts.urgency ?? "normal",
        Topic: crypto.createHash("sha256").update(message.tag).digest("base64url").slice(0, 32),
      },
      body: new Uint8Array(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status };
  } catch {
    return { ok: false, gone: false, status: 0 };
  }
}
