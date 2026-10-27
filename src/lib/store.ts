"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AppSettings, MediaItem, UserProfile } from "./types";
import {
  episodeProgressKey,
  getResumePlayback,
  type LastWatchedEntry,
} from "./watch-progress";
import { isSeriesItem, watchIdForItem } from "./watch-url";
import {
  DEFAULT_PROFILE_PREFERENCES,
  normalizeProfilePreferences,
  type ProfilePreferences,
  type TitlePreferences,
} from "./profile-preferences";
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from "./notifications/preferences";

interface AuthUser {
  id: string;
  name: string;
  role?: "owner" | "admin" | "user";
  isAdmin?: boolean;
}

export interface QueueEntry {
  id: string;
  addedAt: number;
}

type UserStatePayload = {
  profiles: UserProfile[];
  activeProfileId: string | null;
  myListByProfile: Record<string, string[]>;
  queueByProfile?: Record<string, QueueEntry[]>;
  continueWatchingByProfile: Record<string, Record<string, number>>;
  lastWatchedByProfile?: Record<string, Record<string, LastWatchedEntry>>;
  preferencesByProfile?: Record<string, ProfilePreferences>;
};

export interface ProgressUpdateMeta {
  season?: number;
  episode?: number;
  seriesId?: string;
  /** Card metadata stored with the entry (Continue Watching for Real-Debrid/TMDB titles). */
  item?: import("./watch-progress").WatchedItemMeta;
  positionSeconds?: number;
  durationSeconds?: number;
}

interface AppState {
  user: AuthUser | null;
  userStateReady: boolean;
  profiles: UserProfile[];
  activeProfileId: string | null;
  myListByProfile: Record<string, string[]>;
  queueByProfile: Record<string, QueueEntry[]>;
  continueWatchingByProfile: Record<string, Record<string, number>>;
  lastWatchedByProfile: Record<string, Record<string, LastWatchedEntry>>;
  preferencesByProfile: Record<string, ProfilePreferences>;
  /** Server playback settings as the browser may see them (never credentials). */
  settings: AppSettings;
  setUser: (user: AuthUser | null) => void;
  hydrateUserState: (state: UserStatePayload) => void;
  /**
   * Records the profile the server just confirmed (POST /api/user/profiles {action: "select"} sets
   * the signed profile cookie). Use selectProfile() from lib/profile-client to switch profiles.
   */
  setActiveProfile: (id: string | null) => void;
  addToMyList: (id: string) => void;
  removeFromMyList: (id: string) => void;
  addToQueue: (id: string) => void;
  removeFromQueue: (id: string) => void;
  updateProgress: (id: string, progress: number, meta?: ProgressUpdateMeta) => void;
  updateSettings: (settings: Partial<AppState["settings"]>) => void;
  /** Updates the active profile's preferences (optimistic) and saves them on the server. */
  updatePreferences: (patch: Partial<ProfilePreferences>) => void;
  /** Remembers a per-title choice for the active profile (when rememberLanguage is on). */
  rememberTitlePreference: (watchId: string, patch: Partial<TitlePreferences>) => void;
  logoutLocal: () => void;
}

/** Set once this page has confirmed a profile selection with the server. */
let selectedInThisPage = false;

const pendingProgressPatches: Array<{
  profileId: string;
  continueWatchingByProfile: Record<string, Record<string, number>>;
  lastWatchedByProfile: Record<string, Record<string, LastWatchedEntry>>;
}> = [];

async function persistUserStatePatch(patch: Partial<UserStatePayload>): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  try {
    const res = await fetch("/api/user/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      console.warn("[notflix] Failed to save watch progress to server");
    }
  } catch {
    console.warn("[notflix] Could not reach server to save watch progress");
  }
}

function profileKey(state: AppState): string | null {
  return state.activeProfileId;
}

function flushPendingProgress(state: AppState): void {
  if (!state.user || !state.userStateReady) return;
  const pk = state.activeProfileId;
  if (!pk) return;

  const pending = pendingProgressPatches.filter((p) => p.profileId === pk);
  if (pending.length === 0) return;

  const mergedContinue = { ...state.continueWatchingByProfile };
  const mergedLast = { ...state.lastWatchedByProfile };

  for (const patch of pending) {
    mergedContinue[pk] = { ...(mergedContinue[pk] ?? {}), ...(patch.continueWatchingByProfile[pk] ?? {}) };
    mergedLast[pk] = { ...(mergedLast[pk] ?? {}), ...(patch.lastWatchedByProfile[pk] ?? {}) };
  }

  pendingProgressPatches.splice(0, pendingProgressPatches.length);
  void persistUserStatePatch({
    continueWatchingByProfile: mergedContinue,
    lastWatchedByProfile: mergedLast,
  });
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      user: null,
      userStateReady: false,
      profiles: [],
      activeProfileId: null,
      myListByProfile: {},
      queueByProfile: {},
      continueWatchingByProfile: {},
      lastWatchedByProfile: {},
      preferencesByProfile: {},
      settings: {
        directPlay: true,
      },
      setUser: (user) => set({ user }),
      hydrateUserState: (payload) => {
        // The server's active profile (signed cookie) is authoritative. A profile selected in this page
        // a moment ago wins over a slower, older /api/auth/me response, as long as it still exists.
        const local = get().activeProfileId;
        const exists = (id: string | null) => !!id && payload.profiles.some((p) => p.id === id);
        const active = selectedInThisPage && exists(local) ? local : exists(payload.activeProfileId) ? payload.activeProfileId : null;
        set({
          userStateReady: true,
          profiles: payload.profiles,
          activeProfileId: active,
          myListByProfile: payload.myListByProfile,
          queueByProfile: payload.queueByProfile ?? {},
          continueWatchingByProfile: payload.continueWatchingByProfile,
          lastWatchedByProfile: payload.lastWatchedByProfile ?? {},
          // Profiles saved by older versions lack newer fields (e.g. notifications): fill in defaults.
          preferencesByProfile: Object.fromEntries(Object.entries(payload.preferencesByProfile ?? {}).map(([id, p]) => [id, normalizeProfilePreferences(p)])),
        });
        flushPendingProgress(get());
      },
      setActiveProfile: (id) => {
        selectedInThisPage = id !== null;
        set({ activeProfileId: id });
      },
      addToMyList: (id) => {
        const pk = profileKey(get());
        if (!pk || !get().userStateReady) return;
        const lists = get().myListByProfile;
        const current = lists[pk] ?? [];
        if (current.includes(id)) return;
        const myListByProfile = { ...lists, [pk]: [...current, id] };
        set({ myListByProfile });
        void persistUserStatePatch({ myListByProfile });
      },
      removeFromMyList: (id) => {
        const pk = profileKey(get());
        if (!pk || !get().userStateReady) return;
        const lists = get().myListByProfile;
        const myListByProfile = {
          ...lists,
          [pk]: (lists[pk] ?? []).filter((x) => x !== id),
        };
        set({ myListByProfile });
        void persistUserStatePatch({ myListByProfile });
      },
      addToQueue: (id) => {
        const pk = profileKey(get());
        if (!pk || !get().userStateReady) return;
        const queues = get().queueByProfile;
        const current = queues[pk] ?? [];
        if (current.some((entry) => entry.id === id)) return;
        const queueByProfile = {
          ...queues,
          [pk]: [...current, { id, addedAt: Date.now() }],
        };
        set({ queueByProfile });
        void persistUserStatePatch({ queueByProfile });
      },
      removeFromQueue: (id) => {
        const pk = profileKey(get());
        if (!pk || !get().userStateReady) return;
        const queues = get().queueByProfile;
        const queueByProfile = {
          ...queues,
          [pk]: (queues[pk] ?? []).filter((entry) => entry.id !== id),
        };
        set({ queueByProfile });
        void persistUserStatePatch({ queueByProfile });
      },
      updateProgress: (id, progress, meta) => {
        const pk = profileKey(get());
        if (!pk) return;

        const all = get().continueWatchingByProfile;
        const lastAll = get().lastWatchedByProfile;
        const profileProgress = { ...(all[pk] ?? {}) };
        const profileLast = { ...(lastAll[pk] ?? {}) };

        const seriesId = meta?.seriesId ?? id;
        const progressKey =
          meta?.season != null && meta?.episode != null
            ? episodeProgressKey(seriesId, meta.season, meta.episode)
            : id;

        if (progress >= 95) {
          delete profileProgress[progressKey];
          if (meta?.season != null) {
            const existing = profileLast[seriesId];
            if (
              existing?.season === meta.season &&
              existing?.episode === meta.episode
            ) {
              delete profileLast[seriesId];
            }
          } else {
            delete profileLast[id];
          }
        } else if (progress > 0) {
          profileProgress[progressKey] = progress;
          profileProgress[seriesId] = progress;

          const entry: LastWatchedEntry = {
            progress,
            updatedAt: Date.now(),
            season: meta?.season,
            episode: meta?.episode,
            item: meta?.item ?? profileLast[seriesId]?.item,
            positionSeconds: meta?.positionSeconds,
            durationSeconds: meta?.durationSeconds,
          };
          profileLast[seriesId] = entry;
          if (meta?.season == null) {
            profileLast[id] = entry;
          }
        }

        const continueWatchingByProfile = { ...all, [pk]: profileProgress };
        const lastWatchedByProfile = { ...lastAll, [pk]: profileLast };

        set({ continueWatchingByProfile, lastWatchedByProfile });

        if (!get().userStateReady || !get().user) {
          pendingProgressPatches.push({
            profileId: pk,
            continueWatchingByProfile: { [pk]: profileProgress },
            lastWatchedByProfile: { [pk]: profileLast },
          });
          return;
        }

        void persistUserStatePatch({ continueWatchingByProfile, lastWatchedByProfile });
      },
      updateSettings: (settings) => {
        set({ settings: { ...get().settings, ...settings } });
      },
      updatePreferences: (patch) => {
        const pk = get().activeProfileId;
        if (!pk) return;
        const current = normalizeProfilePreferences(get().preferencesByProfile[pk]);
        const next = normalizeProfilePreferences(patch, current);
        set({ preferencesByProfile: { ...get().preferencesByProfile, [pk]: next } });
        if (!get().user) return;
        void fetch("/api/user/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ action: "setPreferences", profileId: pk, preferences: patch }),
        }).catch(() => console.warn("[notflix] Could not save preferences"));
      },
      rememberTitlePreference: (watchId, patch) => {
        const pk = get().activeProfileId;
        if (!pk) return;
        const current = normalizeProfilePreferences(get().preferencesByProfile[pk]);
        if (!current.rememberLanguage) return;
        const titlePrefs = { ...current.titlePrefs, [watchId]: { ...current.titlePrefs[watchId], ...patch, updatedAt: Date.now() } };
        set({ preferencesByProfile: { ...get().preferencesByProfile, [pk]: { ...current, titlePrefs } } });
        if (!get().user) return;
        void fetch("/api/user/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ action: "setTitlePreferences", profileId: pk, watchId, patch }),
        }).catch(() => undefined);
      },
      logoutLocal: () => {
        selectedInThisPage = false;
        set({
          user: null,
          userStateReady: false,
          profiles: [],
          activeProfileId: null,
          myListByProfile: {},
          queueByProfile: {},
          continueWatchingByProfile: {},
          lastWatchedByProfile: {},
          preferencesByProfile: {},
        });
      },
    }),
    {
      name: "notflix-storage",
      partialize: (state) => ({
        // Credentials never reach the browser; only non-secret playback settings are cached.
        settings: state.settings,
        continueWatchingByProfile: state.continueWatchingByProfile,
        lastWatchedByProfile: state.lastWatchedByProfile,
        preferencesByProfile: state.preferencesByProfile,
        // activeProfileId is not persisted: the server's signed profile cookie decides it.
      }),
    }
  )
);

/** Effective preferences of the active profile (defaults when none saved). */
export function getActivePreferences(): ProfilePreferences {
  const s = useAppStore.getState();
  const pk = s.activeProfileId;
  return pk ? normalizeProfilePreferences(s.preferencesByProfile[pk]) : DEFAULT_PROFILE_PREFERENCES;
}

/** Hook form: re-renders when the active profile's preferences change. */
export function useActivePreferences(): ProfilePreferences {
  return useAppStore((s) => {
    const pk = s.activeProfileId;
    return pk ? s.preferencesByProfile[pk] : undefined;
  }) ?? DEFAULT_PROFILE_PREFERENCES;
}

/** Notification preferences of the active profile (defaults when none saved). */
export function useNotificationPreferences(): NotificationPreferences {
  return (
    useAppStore((s) => {
      const pk = s.activeProfileId;
      return pk ? s.preferencesByProfile[pk]?.notifications : undefined;
    }) ?? DEFAULT_NOTIFICATION_PREFERENCES
  );
}

export function getActiveMyList(): string[] {
  const s = useAppStore.getState();
  const pk = s.activeProfileId;
  if (!pk) return [];
  return s.myListByProfile[pk] ?? [];
}

export function isInMyList(id: string): boolean {
  return getActiveMyList().includes(id);
}

export function getActiveQueue(): QueueEntry[] {
  const s = useAppStore.getState();
  const pk = s.activeProfileId;
  if (!pk) return [];
  return s.queueByProfile[pk] ?? [];
}

export function isInQueue(id: string): boolean {
  return getActiveQueue().some((entry) => entry.id === id);
}

export function getMediaProgress(id: string): number {
  const s = useAppStore.getState();
  const pk = s.activeProfileId;
  if (!pk) return 0;
  return s.continueWatchingByProfile[pk]?.[id] ?? 0;
}

export function getLastWatched(mediaId: string): LastWatchedEntry | null {
  const s = useAppStore.getState();
  const pk = s.activeProfileId;
  if (!pk) return null;
  return s.lastWatchedByProfile[pk]?.[mediaId] ?? null;
}

export function getResumeForItem(item: MediaItem): ReturnType<typeof getResumePlayback> {
  const s = useAppStore.getState();
  const pk = s.activeProfileId;
  if (!pk) return null;
  const progressMap = s.continueWatchingByProfile[pk] ?? {};
  const lastWatched = s.lastWatchedByProfile[pk]?.[watchIdForItem(item)] ?? null;
  return getResumePlayback(item, progressMap, lastWatched);
}

export function getContinueWatchingItems(allItems: MediaItem[]): MediaItem[] {
  const s = useAppStore.getState();
  const pk = s.activeProfileId;
  if (!pk) return [];

  const progress = s.continueWatchingByProfile[pk] ?? {};
  const lastWatched = s.lastWatchedByProfile[pk] ?? {};
  const byId = new Map(allItems.map((i) => [i.id, i]));

  const entries = Object.entries(lastWatched)
    .map(([mediaId, entry]) => {
      const item: MediaItem | undefined =
        byId.get(mediaId) ??
        (entry.item
          ? ({ ...entry.item, id: mediaId, source: "tmdb", type: entry.item.type === "episode" ? "series" : entry.item.type } as MediaItem)
          : undefined);
      if (!item || entry.progress <= 0 || entry.progress >= 95) return null;

      if (isSeriesItem(item) && entry.season != null && entry.episode != null) {
        const epKey = episodeProgressKey(mediaId, entry.season, entry.episode);
        const epProgress = progress[epKey] ?? entry.progress;
        if (epProgress <= 0 || epProgress >= 95) return null;
        return {
          item: { ...item, progress: epProgress, season: entry.season, episode: entry.episode },
          updatedAt: entry.updatedAt,
        };
      }

      const p = progress[mediaId] ?? entry.progress;
      if (p <= 0 || p >= 95) return null;
      return { item: { ...item, progress: p }, updatedAt: entry.updatedAt };
    })
    .filter(Boolean) as Array<{ item: MediaItem; updatedAt: number }>;

  if (entries.length > 0) {
    return entries
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((e) => e.item);
  }

  return allItems
    .filter((i) => progress[i.id] && progress[i.id] > 0 && progress[i.id] < 95)
    .map((i) => ({ ...i, progress: progress[i.id] }));
}
