"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { useAppStore } from "@/lib/store";

interface ConfigAlert {
  id: string;
  message: string;
  href: string;
}

/**
 * Owner-only banner when a required credential is missing or no longer accepted (for example an
 * expired Real-Debrid token). It links to the wizard step that fixes it; nothing is reset.
 */
export function OwnerConfigAlert() {
  const isOwner = useAppStore((s) => s.user?.role === "owner");
  const [alerts, setAlerts] = useState<ConfigAlert[]>([]);

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    void fetch("/api/config/alerts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { alerts: [] }))
      .then((d: { alerts?: ConfigAlert[] }) => {
        if (!cancelled) setAlerts(d.alerts ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isOwner]);

  if (!isOwner || alerts.length === 0) return null;
  return (
    <div role="alert" data-testid="owner-config-alert" className="mx-4 mb-4 rounded-md bg-amber-950/70 px-4 py-3 text-sm text-amber-100 ring-1 ring-amber-500/40 md:mx-12">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
        <div className="space-y-1">
          <p className="font-semibold text-white">Notflix needs attention (only you, the owner, see this)</p>
          {alerts.map((a) => (
            <p key={a.id}>
              {a.message}{" "}
              <Link className="underline hover:text-white" href={a.href}>
                Fix it
              </Link>
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
