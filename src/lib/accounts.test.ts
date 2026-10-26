import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { certificationAllowed, profileMaturity, strictestLevel } from "./maturity";
import { clearHits, recordHit, retryAfter } from "./rate-limit";
import { createProfileToken, createSessionToken, parseProfileToken, parseSessionToken } from "./session";

// Account storage lives in <NOTFLIX_DATA_DIR>/db: point it at a throwaway directory before loading the module.
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "notflix-accounts-"));
process.env.NOTFLIX_DATA_DIR = rootDir;
const dataDir = path.join(rootDir, "db");
let users: typeof import("./users");
let avatars: typeof import("./avatar-store");

beforeAll(async () => {
  users = await import("./users");
  avatars = await import("./avatar-store");
});
afterAll(() => fs.rmSync(rootDir, { recursive: true, force: true }));

describe("maturity policy", () => {
  it("allows only known ratings within the level; unknown is hidden on restricted profiles", () => {
    expect(certificationAllowed("G", "little-kids")).toBe(true);
    expect(certificationAllowed("PG", "little-kids")).toBe(false);
    expect(certificationAllowed("PG", "kids")).toBe(true);
    expect(certificationAllowed("TV-PG", "kids")).toBe(true);
    expect(certificationAllowed("PG-13", "kids")).toBe(false);
    expect(certificationAllowed("TV-14", "teens")).toBe(true);
    expect(certificationAllowed("R", "teens")).toBe(false);
    expect(certificationAllowed("TV-MA", "teens")).toBe(false);
    expect(certificationAllowed(null, "kids")).toBe(false);
    expect(certificationAllowed("NR", "kids")).toBe(false);
    expect(certificationAllowed(undefined, "all")).toBe(true);
    expect(certificationAllowed("NC-17", "all")).toBe(true);
  });

  it("derives a profile's level conservatively", () => {
    expect(profileMaturity({ isKids: true })).toBe("kids");
    expect(profileMaturity({ isKids: true, maturity: "all" })).toBe("kids"); // never widened
    expect(profileMaturity({ isKids: true, maturity: "little-kids" })).toBe("little-kids");
    expect(profileMaturity({ maturity: "teens" })).toBe("teens");
    expect(profileMaturity({})).toBe("all");
    expect(strictestLevel(["all", "teens", "kids"])).toBe("kids");
    expect(strictestLevel(["all"])).toBe("all");
  });
});

describe("rate limiting", () => {
  it("blocks after the limit within the window and recovers after it", () => {
    const rule = { max: 3, windowMs: 1000 };
    const key = "test:" + Math.random();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(retryAfter(key, rule, t0 + i)).toBe(0);
      recordHit(key, rule, t0 + i);
    }
    expect(retryAfter(key, rule, t0 + 10)).toBeGreaterThan(0);
    expect(retryAfter(key, rule, t0 + 1001)).toBe(0); // first hit aged out
    clearHits(key);
    expect(retryAfter(key, rule, t0 + 20)).toBe(0);
  });
});

describe("session and profile tokens", () => {
  // Legacy three-part tokens (`userId.exp.sig`) are covered end to end: e2e/helpers forgeSessionToken mints them.
  it("sign the version, so it cannot be dropped or changed", async () => {
    const token = await createSessionToken("u1");
    expect((await parseSessionToken(token))?.version).toBe(0);
    const [id, exp, , sig] = token.split(".");
    expect(await parseSessionToken(`${id}.${exp}.${sig}`)).toBeNull();
    expect(await parseSessionToken(`${id}.${exp}.1.${sig}`)).toBeNull();
  });

  it("bind the profile token to the account", async () => {
    const token = await createProfileToken("acct-1", "prof-9");
    expect(await parseProfileToken(token, "acct-1")).toBe("prof-9");
    expect(await parseProfileToken(token, "acct-2")).toBeNull();
    expect(await parseProfileToken(token.replace("prof-9", "prof-8"), "acct-1")).toBeNull();
  });
});

describe("accounts and roles", () => {
  it("never makes an ordinary sign-up the owner, even on an empty server", async () => {
    const first = await users.createUser("first-user", "password-1");
    expect(users.roleOf(first)).toBe("user");
    expect(users.hasOwner()).toBe(false);
  });

  it("creates exactly one owner, also under concurrent requests", async () => {
    const attempts = await Promise.allSettled(
      ["owner-a", "owner-b", "owner-c", "owner-d"].map((n) => users.createOwner(n, "owner-password", "The Owner"))
    );
    const created = attempts.filter((r) => r.status === "fulfilled");
    expect(created).toHaveLength(1);
    expect(attempts.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof users.OwnerExistsError)).toBe(true);
    expect(users.listUsers().filter((u) => u.role === "owner")).toHaveLength(1);
    await expect(users.createOwner("late-owner", "owner-password")).rejects.toBeInstanceOf(users.OwnerExistsError);
    const owner = users.listUsers().find((u) => u.role === "owner")!;
    expect(owner.displayName).toBe("The Owner");
    // The owner's first profile is named after the display name.
    expect(users.readUserState(owner.id).profiles[0].name).toBe("The Owner");
  });

  it("validates new accounts", async () => {
    await users.createUser("second-user", "password-2");
    await expect(users.createUser("SECOND-user", "password-3")).rejects.toThrow(/taken/);
    await expect(users.createUser("x", "password-3")).rejects.toThrow(/Username/);
    await expect(users.createUser("third-user", "short")).rejects.toThrow(/8 characters/);
    await expect(users.createUser("fourth-user", "password-4", { displayName: "<script>" })).rejects.toThrow(/Display name/);
  });

  it("stores modern scrypt hashes and still accepts (and upgrades) the legacy format", async () => {
    const { hashPassword, verifyPassword, needsRehash } = await import("./auth");
    const modern = await hashPassword("correct horse");
    expect(modern).toMatch(/^scrypt\$131072,8,1\$/);
    expect(await verifyPassword("correct horse", modern)).toBe(true);
    expect(await verifyPassword("wrong horse", modern)).toBe(false);
    expect(needsRehash(modern)).toBe(false);
    // Legacy `salt:hash` (scrypt N=16384, 64-byte key) from earlier builds.
    const { scryptSync } = await import("node:crypto");
    const legacy = `abcdef0123456789:${scryptSync("old-password", "abcdef0123456789", 64).toString("hex")}`;
    expect(await verifyPassword("old-password", legacy)).toBe(true);
    expect(needsRehash(legacy)).toBe(true);
    const file = path.join(dataDir, "users.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.users.find((u: { name: string }) => u.name === "second-user").passwordHash = legacy;
    fs.writeFileSync(file, JSON.stringify(data));
    expect(await users.authenticateUser("second-user", "old-password")).not.toBeNull();
    const upgraded = JSON.parse(fs.readFileSync(file, "utf8")).users.find((u: { name: string }) => u.name === "second-user").passwordHash;
    expect(upgraded).toMatch(/^scrypt\$/);
    expect(await users.authenticateUser("second-user", "old-password")).not.toBeNull();
    // No plaintext anywhere in the accounts file.
    expect(fs.readFileSync(file, "utf8")).not.toContain("old-password");
  });

  it("revokes other sessions when the password changes", async () => {
    const u = users.listUsers().find((x) => x.name === "first-user")!;
    const before = users.getUserById(u.id)!.sessionVersion ?? 0;
    await expect(users.changePassword(u.id, "wrong", "new-password-1")).rejects.toThrow(/incorrect/);
    await users.changePassword(u.id, "password-1", "new-password-1");
    expect(users.getUserById(u.id)!.sessionVersion).toBe(before + 1);
    expect(await users.authenticateUser("first-user", "new-password-1")).not.toBeNull();
    expect(await users.authenticateUser("first-user", "password-1")).toBeNull();
    const temp = await users.resetPassword(u.id);
    expect(await users.authenticateUser("first-user", temp)).not.toBeNull();
  });
});

describe("profiles", () => {
  it("keeps PIN hashes server-side and validates edits", async () => {
    const u = users.listUsers().find((x) => x.name === "second-user")!;
    const p = users.addProfile(u.id, { name: "Teen", avatar: "builtin:space-rocket", maturity: "teens" });
    expect(p.maturity).toBe("teens");
    await users.setProfilePin(u.id, p.id, "4321");
    const stored = users.getProfile(u.id, p.id)!;
    expect(stored.pinHash).toMatch(/^scrypt\$/);
    expect(await users.verifyProfilePin(stored, "4321")).toBe(true);
    expect(await users.verifyProfilePin(stored, "1234")).toBe(false);
    const pub = users.publicUserState(users.readUserState(u.id)).profiles.find((x) => x.id === p.id)!;
    expect(pub.hasPin).toBe(true);
    expect("pinHash" in pub).toBe(false);
    await expect(users.setProfilePin(u.id, p.id, "12a4")).rejects.toThrow(/4 digits/);
    expect(() => users.updateProfile(u.id, p.id, { avatar: "builtin:not-real" })).toThrow(/Unknown avatar/);
    expect(() => users.updateProfile(u.id, p.id, { avatar: "upload:someone-else.webp" })).toThrow();
    expect(() => users.updateProfile(u.id, p.id, { name: "main" })).toThrow(/already uses/);
  });

  it("deletes everything stored for a removed profile", () => {
    const u = users.listUsers().find((x) => x.name === "second-user")!;
    const p = users.addProfile(u.id, { name: "Temp", avatar: "builtin:minimal-dot" });
    const state = users.readUserState(u.id);
    state.myListByProfile[p.id] = ["tmdb-1"];
    state.continueWatchingByProfile[p.id] = { "tmdb-1": 40 };
    state.lastWatchedByProfile = { [p.id]: { "tmdb-1": { progress: 40, updatedAt: 1 } } };
    users.writeUserState(u.id, state);
    users.removeProfile(u.id, p.id);
    const after = users.readUserState(u.id);
    expect(after.profiles.some((x) => x.id === p.id)).toBe(false);
    expect(after.myListByProfile[p.id]).toBeUndefined();
    expect(after.continueWatchingByProfile[p.id]).toBeUndefined();
    expect(after.lastWatchedByProfile?.[p.id]).toBeUndefined();
  });

  it("keeps a corrupt state file instead of overwriting it", () => {
    const u = users.listUsers().find((x) => x.name === "first-user")!;
    const file = path.join(dataDir, "users", `${u.id}.json`);
    fs.writeFileSync(file, "{ not json");
    users.readUserState(u.id);
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith(`${u.id}.json.corrupt-`))).toBe(true);
  });
});

describe("avatar uploads", () => {
  const split = (w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: "#ff0000" } })
      .composite([{ input: { create: { width: w / 2, height: h, channels: 3, background: "#0000ff" } }, left: w / 2, top: 0 }]);
  const pixel = async (buf: Buffer, x: number, y: number) => {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const isRed = ([r, g, b]: number[]) => r > 200 && g < 60 && b < 60;
  const isBlue = ([r, g, b]: number[]) => b > 200 && r < 60 && g < 60;

  it("re-encodes to a 256 px WebP, applies the crop and strips metadata", async () => {
    const png = await split(800, 400).png().toBuffer();
    const out = await avatars.processAvatar(png, { x: 400, y: 0, size: 400 }); // right half: blue
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 256, 256]);
    expect(meta.exif).toBeUndefined();
    expect(isBlue(await pixel(out, 128, 128))).toBe(true);
    const centred = await avatars.processAvatar(png, null); // centre square: red | blue
    expect(isRed(await pixel(centred, 20, 128))).toBe(true);
    expect(isBlue(await pixel(centred, 236, 128))).toBe(true);
  });

  it("honours EXIF orientation (crop coordinates are in the displayed image)", async () => {
    // Stored 800×400 with left red / right blue, tagged "rotate 90° clockwise": displayed 400×800, red on top.
    const jpeg = await split(800, 400).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const out = await avatars.processAvatar(jpeg, null);
    expect(isRed(await pixel(out, 128, 20))).toBe(true);
    expect(isBlue(await pixel(out, 128, 236))).toBe(true);
    expect((await sharp(out).metadata()).orientation).toBeUndefined();
  });

  it("rejects non-images, wrong types, truncated files and oversized images", async () => {
    await expect(avatars.processAvatar(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), null)).rejects.toThrow(/JPEG, PNG or WebP/);
    const gif = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#fff" } }).gif().toBuffer();
    await expect(avatars.processAvatar(gif, null)).rejects.toThrow(/JPEG, PNG or WebP/);
    const jpeg = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#0f0" } }).jpeg().toBuffer();
    await expect(avatars.processAvatar(jpeg.subarray(0, Math.floor(jpeg.length / 3)), null)).rejects.toThrow();
    const huge = await sharp({ create: { width: 6000, height: 5000, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer();
    await expect(avatars.processAvatar(huge, null)).rejects.toThrow(/megapixels|too large|could not be read/);
    const tiny = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#000" } }).png().toBuffer();
    await expect(avatars.processAvatar(tiny, null)).rejects.toThrow(/at least 64/);
    await expect(avatars.processAvatar(Buffer.alloc(avatars.MAX_UPLOAD_BYTES + 1, 0xff), null)).rejects.toThrow(/8 MB/);
  });

  it("stores uploads per profile and only replaces that profile's file", () => {
    const a = avatars.saveAvatarFile("acct-x", "profile-a", Buffer.from("a"));
    const b = avatars.saveAvatarFile("acct-x", "profile-b", Buffer.from("b"));
    const a2 = avatars.saveAvatarFile("acct-x", "profile-a", Buffer.from("a2"));
    expect(avatars.avatarFilePath("acct-x", a)).toBeNull(); // old upload of profile-a removed
    expect(avatars.avatarFilePath("acct-x", b)).not.toBeNull(); // profile-b untouched
    expect(avatars.avatarFilePath("acct-x", a2)).not.toBeNull();
    expect(avatars.avatarFilePath("acct-y", b)).toBeNull(); // another account cannot read it
    expect(avatars.avatarFilePath("acct-x", "../users.json")).toBeNull();
    expect(path.resolve(avatars.avatarDir("acct-x")).startsWith(path.resolve(dataDir))).toBe(true);
  });
});
