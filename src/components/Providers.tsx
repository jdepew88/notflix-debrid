"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { PortalProvider } from "@/providers/PortalProvider";
import { DetailModalProvider } from "@/providers/DetailModalProvider";
import { TitleContextMenuProvider } from "@/providers/TitleContextMenuProvider";
import { TitleCardPortal } from "@/components/browse/TitleCardPortal";
import { DetailModal } from "@/components/browse/DetailModal";
import { NotificationsProvider } from "@/components/notifications/NotificationsProvider";
import { useAppStore } from "@/lib/store";

function AppHydrator() {
  const router = useRouter();
  const updateSettings = useAppStore((s) => s.updateSettings);
  const setUser = useAppStore((s) => s.setUser);
  const hydrateUserState = useAppStore((s) => s.hydrateUserState);
  const logoutLocal = useAppStore((s) => s.logoutLocal);
  const user = useAppStore((s) => s.user);
  const activeProfileId = useAppStore((s) => s.activeProfileId);

  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      try {
        const [configRes, meRes] = await Promise.all([
          fetch("/api/settings/sync", { credentials: "same-origin" }),
          fetch("/api/auth/me", { credentials: "same-origin" }),
        ]);

        if (!cancelled && configRes.ok) {
          const data = await configRes.json();
          if (data.settings) updateSettings(data.settings);
        }

        if (!cancelled && meRes.ok) {
          const data = await meRes.json();
          setUser(data.user);
          hydrateUserState(data.state);
        } else if (!cancelled && meRes.status === 401) {
          logoutLocal();
        }
      } catch {
        /* optional */
      }
    }

    hydrate();
    return () => {
      cancelled = true;
    };
  }, [updateSettings, setUser, hydrateUserState, logoutLocal]);

  useEffect(() => {
    const path = window.location.pathname;
    if (
      user &&
      (path.startsWith("/browse") || path.startsWith("/watch") || path.startsWith("/settings")) &&
      !activeProfileId
    ) {
      // The server has no profile for this browser (new sign-in, switched away, or cookie expired).
      const back = path + window.location.search;
      router.replace(back === "/browse" ? "/profiles" : `/profiles?next=${encodeURIComponent(back)}`);
    }
  }, [user, activeProfileId, router]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    void import("@/lib/cast-init").then(({ initCastFramework }) => initCastFramework());
  }, []);

  return (
    <PortalProvider>
      <DetailModalProvider>
        <TitleContextMenuProvider>
          <AppHydrator />
          <NotificationsProvider>
            {children}
            <TitleCardPortal />
            <DetailModal />
          </NotificationsProvider>
        </TitleContextMenuProvider>
      </DetailModalProvider>
    </PortalProvider>
  );
}

declare global {
  interface Window {
    cast?: typeof cast;
    chrome: typeof chrome;
  }
}
