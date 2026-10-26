import type { UserProfile } from "./types";

export async function completeClientAuth(
  user: { id: string; name: string },
  setUser: (user: { id: string; name: string }) => void,
  hydrateUserState: (state: {
    profiles: UserProfile[];
    activeProfileId: string | null;
    myListByProfile: Record<string, string[]>;
    continueWatchingByProfile: Record<string, Record<string, number>>;
  }) => void,
  redirectTo = "/profiles"
): Promise<void> {
  setUser(user);

  const meRes = await fetch("/api/auth/me", { credentials: "include" });
  if (!meRes.ok) {
    throw new Error(
      "Account was created but the session cookie was not saved. If you use HTTP (not HTTPS), set COOKIE_SECURE=false in your environment."
    );
  }

  const data = await meRes.json();
  if (data.state) {
    hydrateUserState(data.state);
  }

  window.location.assign(redirectTo.startsWith("/") ? redirectTo : "/profiles");
}
