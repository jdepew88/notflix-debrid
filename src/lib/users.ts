import fs from "fs";
import path from "path";
import { randomBytes, randomUUID } from "crypto";
import type { UserProfile } from "./types";
import { getDataPath } from "./data-path";
import { hashPassword, needsRehash, usersFilePath, verifyPassword } from "./auth";
import { withFileLock } from "./install/store.mjs";
import {
  DEFAULT_PROFILE_PREFERENCES,
  normalizeProfilePreferences,
  type ProfilePreferences,
  type TitlePreferences,
} from "./profile-preferences";
import { isMaturityLevel, type MaturityLevel } from "./maturity";
import { DEFAULT_AVATAR, DEFAULT_KIDS_AVATAR, isBuiltinAvatar } from "./avatars";

/**
 * - owner: one account, created by first-run setup (or an explicit offline claim).
 * - admin: may change server settings and credentials; granted by the owner.
 * - user:  browses and plays; manages only its own profiles and preferences.
 * Accounts that predate roles have no `role` field and are treated as "user".
 */
export type AccountRole = "owner" | "admin" | "user";

export interface UserAccount {
  id: string;
  name: string;
  /** Optional friendly name shown in the interface; `name` stays the sign-in username. */
  displayName?: string;
  passwordHash: string;
  createdAt: string;
  role?: AccountRole;
  /** Bumped when the password changes; older session tokens stop working. */
  sessionVersion?: number;
  passwordChangedAt?: string;
}

export interface LastWatchedEntry {
  item?: import("./watch-progress").WatchedItemMeta;
  season?: number;
  episode?: number;
  progress: number;
  updatedAt: number;
}

export interface QueueEntry {
  id: string;
  addedAt: number;
}

export interface UserState {
  profiles: UserProfile[];
  activeProfileId: string | null;
  myListByProfile: Record<string, string[]>;
  queueByProfile?: Record<string, QueueEntry[]>;
  continueWatchingByProfile: Record<string, Record<string, number>>;
  lastWatchedByProfile?: Record<string, Record<string, LastWatchedEntry>>;
  preferencesByProfile?: Record<string, ProfilePreferences>;
}

interface UsersFile {
  users: UserAccount[];
}

export const MAX_PROFILES = 8;
export const MIN_PASSWORD_LENGTH = 8;
/** Accounts created before the 8-character rule keep working with their existing password. */
const LEGACY_MIN_PASSWORD_LENGTH = 4;

/** A new account starts with one profile (named after the account) and a Kids profile. */
function defaultProfiles(mainName = "Main"): UserProfile[] {
  const main = mainName.trim().replace(/[<>]/g, "").slice(0, 30) || "Main";
  return [
    { id: "1", name: main.toLowerCase() === "kids" ? "Main" : main, avatar: DEFAULT_AVATAR },
    { id: "2", name: "Kids", avatar: DEFAULT_KIDS_AVATAR, isKids: true, maturity: "kids" },
  ];
}

/** Writes JSON through a temporary file and a rename, so a crash never leaves a half-written file. */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows refuses the rename while another process holds the target open; fall back to a direct write.
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    fs.rmSync(tmp, { force: true });
  }
}

function readUsersFile(): UsersFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(usersFilePath(), "utf8")) as UsersFile;
    return { users: Array.isArray(parsed.users) ? parsed.users : [] };
  } catch {
    return { users: [] };
  }
}

/** Serializes read-modify-write of the accounts file across requests and processes. */
function withUsersLock<T>(fn: () => T): T {
  return withFileLock(`${usersFilePath()}.lock`, fn);
}

function writeUsersFile(data: UsersFile): void {
  const file = usersFilePath();
  try {
    writeJsonAtomic(file, data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "write failed";
    throw new Error(`Could not save account data to ${file}. Check DATA_PATH permissions (${message}).`);
  }
}

function userStatePath(userId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(userId)) throw new Error("Invalid account id");
  return path.join(getDataPath(), "users", `${userId}.json`);
}

function defaultUserState(mainName?: string): UserState {
  return {
    profiles: defaultProfiles(mainName).map((p) => ({ ...p, id: randomUUID(), createdAt: new Date().toISOString() })),
    activeProfileId: null,
    myListByProfile: {},
    continueWatchingByProfile: {},
  };
}

export function readUserState(userId: string): UserState {
  const file = userStatePath(userId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    const state = defaultUserState();
    writeUserState(userId, state);
    return state;
  }
  try {
    const parsed = JSON.parse(raw) as UserState;
    return {
      profiles: parsed.profiles?.length ? parsed.profiles : defaultUserState().profiles,
      activeProfileId: parsed.activeProfileId ?? null,
      myListByProfile: parsed.myListByProfile ?? {},
      queueByProfile: parsed.queueByProfile ?? {},
      continueWatchingByProfile: parsed.continueWatchingByProfile ?? {},
      lastWatchedByProfile: parsed.lastWatchedByProfile ?? {},
      preferencesByProfile: parsed.preferencesByProfile ?? {},
    };
  } catch {
    // Never overwrite an unreadable file: keep it for recovery and start fresh beside it.
    fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    const state = defaultUserState();
    writeUserState(userId, state);
    return state;
  }
}

export function writeUserState(userId: string, state: UserState): void {
  const file = userStatePath(userId);
  try {
    writeJsonAtomic(file, state);
  } catch (err) {
    const message = err instanceof Error ? err.message : "write failed";
    throw new Error(`Could not save profile data to ${file}. Check DATA_PATH permissions (${message}).`);
  }
}

/** State as a browser may see it: PIN hashes replaced by `hasPin`. */
export function publicUserState(state: UserState): UserState {
  return { ...state, profiles: state.profiles.map(publicProfile) };
}

export function publicProfile(profile: UserProfile): UserProfile {
  const { pinHash, ...rest } = profile;
  return { ...rest, hasPin: Boolean(pinHash) };
}

// ---------------------------------------------------------------------------------------------
// Accounts

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,31}$/u;

export function roleOf(user: Pick<UserAccount, "role"> | null | undefined): AccountRole {
  return user?.role === "owner" || user?.role === "admin" ? user.role : "user";
}

export function isAdminRole(role: AccountRole): boolean {
  return role === "owner" || role === "admin";
}

function validateNewAccount(name: string, password: string): string {
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) {
    throw new Error("Username must be 2–32 characters: letters, numbers, spaces, dots, dashes or underscores");
  }
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (password.length > 200) throw new Error("Password is too long");
  return trimmed;
}

function cleanDisplayName(displayName: unknown): string | undefined {
  if (typeof displayName !== "string") return undefined;
  const t = displayName.trim().replace(/\s+/g, " ");
  if (!t) return undefined;
  if (t.length > 40 || /[<>]/.test(t)) throw new Error("Display name must be up to 40 characters without < or >");
  return t;
}

/**
 * Creates a regular account (or an administrator, when the owner creates one). Never creates an
 * owner: the owner comes only from first-run setup (`createOwner`).
 */
export async function createUser(
  name: string,
  password: string,
  opts: { role?: "admin" | "user"; displayName?: string } = {}
): Promise<UserAccount> {
  const trimmed = validateNewAccount(name, password);
  const displayName = cleanDisplayName(opts.displayName);
  const passwordHash = await hashPassword(password);
  const user = withUsersLock(() => {
    const data = readUsersFile();
    if (data.users.some((u) => u.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error("That username is already taken");
    }
    const created: UserAccount = {
      id: randomUUID(),
      name: trimmed,
      ...(displayName ? { displayName } : {}),
      passwordHash,
      createdAt: new Date().toISOString(),
      role: opts.role === "admin" ? "admin" : "user",
      sessionVersion: 0,
    };
    data.users.push(created);
    writeUsersFile(data);
    return created;
  });
  writeUserState(user.id, defaultUserState(user.displayName));
  return user;
}

export class OwnerExistsError extends Error {
  constructor() {
    super("This server already has an owner.");
    this.name = "OwnerExistsError";
  }
}

/**
 * Creates the one and only owner account. Concurrent requests are serialized by a lock file and
 * the check happens inside the lock, so at most one owner can ever be created this way.
 */
export async function createOwner(name: string, password: string, displayName?: string): Promise<UserAccount> {
  const trimmed = validateNewAccount(name, password);
  const cleanName = cleanDisplayName(displayName);
  if (hasOwner()) throw new OwnerExistsError();
  const passwordHash = await hashPassword(password);
  const owner = withUsersLock(() => {
    const data = readUsersFile();
    if (data.users.some((u) => roleOf(u) === "owner")) throw new OwnerExistsError();
    if (data.users.some((u) => u.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error("That username is already taken");
    }
    const created: UserAccount = {
      id: randomUUID(),
      name: trimmed,
      ...(cleanName ? { displayName: cleanName } : {}),
      passwordHash,
      createdAt: new Date().toISOString(),
      role: "owner",
      sessionVersion: 0,
    };
    data.users.push(created);
    writeUsersFile(data);
    return created;
  });
  writeUserState(owner.id, defaultUserState(owner.displayName));
  return owner;
}

export async function authenticateUser(name: string, password: string): Promise<UserAccount | null> {
  const trimmed = name.trim();
  const data = readUsersFile();
  const user = data.users.find((u) => u.name.toLowerCase() === trimmed.toLowerCase());
  if (!user) {
    // Same cost as a real check, so response time does not reveal whether the name exists.
    await verifyPassword(password, await dummyHash());
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  if (needsRehash(user.passwordHash)) {
    // Upgrade hashes from earlier builds transparently on a successful sign-in.
    const upgraded = await hashPassword(password);
    try {
      return updateUser(user.id, (u) => {
        u.passwordHash = upgraded;
      });
    } catch {
      return user;
    }
  }
  return user;
}

let dummy: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  return (dummy ??= hashPassword(randomBytes(12).toString("hex")));
}

export function getUserById(userId: string): UserAccount | null {
  return readUsersFile().users.find((u) => u.id === userId) ?? null;
}

export function listUsers(): Array<{ id: string; name: string; displayName?: string; role: AccountRole; createdAt: string }> {
  return readUsersFile().users.map((u) => ({ id: u.id, name: u.name, displayName: u.displayName, role: roleOf(u), createdAt: u.createdAt }));
}

export function countUsers(): number {
  return readUsersFile().users.length;
}

function updateUser(userId: string, mutate: (user: UserAccount) => void): UserAccount {
  return withUsersLock(() => {
    const data = readUsersFile();
    const user = data.users.find((u) => u.id === userId);
    if (!user) throw new Error("Account not found");
    mutate(user);
    writeUsersFile(data);
    return user;
  });
}

export async function changePassword(userId: string, current: string, next: string): Promise<UserAccount> {
  const user = getUserById(userId);
  if (!user || !(await verifyPassword(current, user.passwordHash))) throw new Error("Current password is incorrect");
  if (next.length < MIN_PASSWORD_LENGTH) throw new Error(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (next.length > 200) throw new Error("Password is too long");
  const passwordHash = await hashPassword(next);
  return updateUser(userId, (u) => {
    u.passwordHash = passwordHash;
    u.sessionVersion = (u.sessionVersion ?? 0) + 1;
    u.passwordChangedAt = new Date().toISOString();
  });
}

/** Admin recovery: sets a random temporary password and signs the account out everywhere. */
export async function resetPassword(targetId: string): Promise<string> {
  const temporary = `${randomBytes(3).toString("hex")}-${randomBytes(3).toString("hex")}-${randomBytes(3).toString("hex")}`;
  const passwordHash = await hashPassword(temporary);
  updateUser(targetId, (u) => {
    u.passwordHash = passwordHash;
    u.sessionVersion = (u.sessionVersion ?? 0) + 1;
    u.passwordChangedAt = new Date().toISOString();
  });
  return temporary;
}

export function setUserRole(targetId: string, role: "admin" | "user"): UserAccount {
  return updateUser(targetId, (u) => {
    if (roleOf(u) === "owner") throw new Error("The owner's role cannot be changed");
    u.role = role;
  });
}

/** Whether a password is acceptable for sign-in (legacy accounts may have short passwords). */
export function plausiblePassword(password: string): boolean {
  return password.length >= LEGACY_MIN_PASSWORD_LENGTH && password.length <= 200;
}

// Ownership -----------------------------------------------------------------------------------

export function hasOwner(): boolean {
  return readUsersFile().users.some((u) => roleOf(u) === "owner");
}

// ---------------------------------------------------------------------------------------------
// Preferences

/** Effective preferences for a profile (stored values over defaults). */
export function getProfilePreferences(userId: string, profileId: string | null | undefined): ProfilePreferences {
  if (!profileId) return DEFAULT_PROFILE_PREFERENCES;
  const state = readUserState(userId);
  return normalizeProfilePreferences(state.preferencesByProfile?.[profileId]);
}

export function updateProfilePreferences(userId: string, profileId: string, patch: unknown): ProfilePreferences {
  const state = readUserState(userId);
  if (!state.profiles.some((p) => p.id === profileId)) throw new Error("Unknown profile");
  const current = normalizeProfilePreferences(state.preferencesByProfile?.[profileId]);
  const next = normalizeProfilePreferences(patch, current);
  state.preferencesByProfile = { ...(state.preferencesByProfile ?? {}), [profileId]: next };
  writeUserState(userId, state);
  return next;
}

/** Remembers per-title choices (audio/subtitle language, chosen release hash). */
export function updateTitlePreferences(userId: string, profileId: string, watchId: string, patch: Partial<TitlePreferences>): ProfilePreferences {
  const current = getProfilePreferences(userId, profileId);
  const existing = current.titlePrefs[watchId];
  const entries = Object.entries(current.titlePrefs).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 400);
  const titlePrefs = Object.fromEntries(entries);
  titlePrefs[watchId] = { ...existing, ...patch, updatedAt: Date.now() };
  return updateProfilePreferences(userId, profileId, { titlePrefs });
}

// ---------------------------------------------------------------------------------------------
// Profiles

export interface ProfileInput {
  name?: unknown;
  avatar?: unknown;
  isKids?: unknown;
  maturity?: unknown;
}

function cleanProfileName(name: unknown, state: UserState, exceptId?: string): string {
  const trimmed = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (trimmed.length < 1 || trimmed.length > 30) throw new Error("Profile name must be 1–30 characters");
  if (/[<>]/.test(trimmed)) throw new Error("Profile name contains characters that are not allowed");
  if (state.profiles.some((p) => p.id !== exceptId && p.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error("Another profile already uses that name");
  }
  return trimmed;
}

/** Built-in avatar ids and short legacy emoji are accepted from the browser; uploads only via the upload route. */
function cleanAvatar(avatar: unknown, current?: string): string {
  if (avatar === undefined) return current ?? DEFAULT_AVATAR;
  if (typeof avatar !== "string") throw new Error("Invalid avatar");
  if (avatar.startsWith("builtin:")) {
    if (!isBuiltinAvatar(avatar.slice(8))) throw new Error("Unknown avatar");
    return avatar;
  }
  if (avatar.startsWith("upload:")) {
    if (avatar === current) return avatar;
    throw new Error("Upload a photo to use it as an avatar");
  }
  if ([...avatar].length > 0 && [...avatar].length <= 4 && !/[\w<>/\\]/.test(avatar)) return avatar;
  throw new Error("Invalid avatar");
}

export function addProfile(userId: string, input: ProfileInput): UserProfile {
  const state = readUserState(userId);
  if (state.profiles.length >= MAX_PROFILES) throw new Error(`An account can have up to ${MAX_PROFILES} profiles`);
  const isKids = input.isKids === true;
  const profile: UserProfile = {
    id: randomUUID(),
    name: cleanProfileName(input.name, state),
    avatar: cleanAvatar(input.avatar),
    createdAt: new Date().toISOString(),
    ...(isKids ? { isKids: true, maturity: isMaturityLevel(input.maturity) && input.maturity !== "all" ? input.maturity : "kids" } : {}),
    ...(!isKids && isMaturityLevel(input.maturity) && input.maturity !== "all" ? { maturity: input.maturity } : {}),
  };
  state.profiles.push(profile);
  writeUserState(userId, state);
  return profile;
}

export function getProfile(userId: string, profileId: string): UserProfile | null {
  return readUserState(userId).profiles.find((p) => p.id === profileId) ?? null;
}

/** Name/avatar changes. Kids and maturity changes go through `setProfileRestrictions`. */
export function updateProfile(userId: string, profileId: string, input: ProfileInput): UserProfile {
  const state = readUserState(userId);
  const profile = state.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error("Unknown profile");
  if (input.name !== undefined) profile.name = cleanProfileName(input.name, state, profileId);
  if (input.avatar !== undefined) profile.avatar = cleanAvatar(input.avatar, profile.avatar);
  writeUserState(userId, state);
  return profile;
}

export function setProfileAvatar(userId: string, profileId: string, avatar: string): { profile: UserProfile; previous: string } {
  const state = readUserState(userId);
  const profile = state.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error("Unknown profile");
  const previous = profile.avatar;
  profile.avatar = avatar;
  writeUserState(userId, state);
  return { profile, previous };
}

export function setProfileRestrictions(userId: string, profileId: string, isKids: boolean, maturity: MaturityLevel): UserProfile {
  const state = readUserState(userId);
  const profile = state.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error("Unknown profile");
  if (isKids) {
    profile.isKids = true;
    profile.maturity = maturity === "all" ? "kids" : maturity;
  } else {
    delete profile.isKids;
    if (maturity === "all") delete profile.maturity;
    else profile.maturity = maturity;
  }
  writeUserState(userId, state);
  return profile;
}

export async function setProfilePin(userId: string, profileId: string, pin: string | null): Promise<UserProfile> {
  if (pin !== null && !/^\d{4}$/.test(pin)) throw new Error("A profile PIN is exactly 4 digits");
  const pinHash = pin === null ? null : await hashPassword(pin);
  const state = readUserState(userId);
  const profile = state.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error("Unknown profile");
  if (pinHash === null) delete profile.pinHash;
  else profile.pinHash = pinHash;
  writeUserState(userId, state);
  return profile;
}

export async function verifyProfilePin(profile: UserProfile, pin: unknown): Promise<boolean> {
  if (!profile.pinHash) return true;
  return typeof pin === "string" && /^\d{4}$/.test(pin) && (await verifyPassword(pin, profile.pinHash));
}

/** Removes a profile and everything stored for it. Returns the removed profile (for avatar cleanup). */
export function removeProfile(userId: string, profileId: string): UserProfile {
  const state = readUserState(userId);
  const profile = state.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error("Unknown profile");
  if (state.profiles.length <= 1) throw new Error("You must keep at least one profile");
  state.profiles = state.profiles.filter((p) => p.id !== profileId);
  delete state.myListByProfile[profileId];
  delete state.queueByProfile?.[profileId];
  delete state.continueWatchingByProfile[profileId];
  delete state.lastWatchedByProfile?.[profileId];
  delete state.preferencesByProfile?.[profileId];
  if (state.activeProfileId === profileId) state.activeProfileId = null;
  writeUserState(userId, state);
  return profile;
}
