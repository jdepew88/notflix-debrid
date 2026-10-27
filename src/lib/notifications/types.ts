/**
 * Notification data model. Notifications are stored per profile (see store.ts): each stored
 * notification carries its content and that profile's delivery/read state, so one profile can
 * never see or change another's. Nothing here may hold credentials, stream links or file paths.
 */

/** User-facing categories; each can be turned on or off per profile. */
export type NotificationCategory = "episodes" | "seasons" | "digital" | "physical" | "trending" | "recommendations" | "service";

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = ["episodes", "seasons", "digital", "physical", "trending", "recommendations", "service"];

export type NotificationType =
  | "new-episode"
  | "new-episodes"
  | "season-announced"
  | "season-released"
  | "digital-release"
  | "physical-release"
  | "streaming-available"
  | "trending"
  | "recommendation"
  | "digest"
  | "service";

export type NotificationPriority = "low" | "normal" | "high";

/** Where the information came from (shown for attribution where required). */
export type NotificationSource = "tmdb" | "justwatch-via-tmdb" | "notflix";

/** One title inside a digest notification. */
export interface DigestItem {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  image?: string;
  url: string;
  /** Short reason ("Because you watched …"). */
  reason?: string;
}

/** What a notification says. Produced by the background jobs, delivered to profiles. */
export interface NotificationContent {
  /**
   * Stable key: the same real-world event always produces the same key, so a job that runs again
   * (or a metadata correction) never creates a second notification. Per profile.
   */
  dedupeKey: string;
  type: NotificationType;
  category: NotificationCategory;
  tmdbId?: number;
  mediaType?: "movie" | "tv";
  season?: number;
  episode?: number;
  /** Last episode of a range ("episodes 5–7"). */
  episodeTo?: number;
  title: string;
  body: string;
  /** Plain name of the series or film (for the details view while it loads). */
  name?: string;
  /** TMDB image path (poster or still), e.g. "/abc.jpg"; never a full URL from user input. */
  image?: string;
  /** Release or air date this is about (YYYY-MM-DD). */
  eventDate?: string;
  /** In-app path to open ("/browse?title=…", "/settings#…"). Always a same-origin path. */
  url: string;
  source: NotificationSource;
  /** ISO 3166-1 region the release information applies to. */
  region?: string;
  priority: NotificationPriority;
  /** US certification for maturity filtering; null = known to be unrated/unknown. */
  certification?: string | null;
  /** Service notifications go to the server's owner and administrators only. */
  audience?: "admins";
  /** Title + media for suppression ("don't suggest this again"). */
  subject?: string;
  items?: DigestItem[];
  /** Days until it is removed from the notification center. */
  ttlDays: number;
}

/** A notification as stored for (and shown to) one profile. */
export interface StoredNotification extends Omit<NotificationContent, "ttlDays"> {
  id: string;
  createdAt: string;
  expiresAt: string;
  readAt?: string;
  dismissedAt?: string;
  /** Browser push state for this profile. */
  push?: "pending" | "sent" | "skipped" | "failed";
}

/** What the API returns (no internal fields). */
export type NotificationView = Omit<StoredNotification, "dedupeKey" | "audience" | "subject" | "push" | "certification">;

export interface NotificationPage {
  items: NotificationView[];
  unread: number;
  nextCursor: string | null;
}
