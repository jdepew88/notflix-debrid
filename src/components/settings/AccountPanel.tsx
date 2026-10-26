"use client";

import { useState } from "react";
import Link from "next/link";
import { KeyRound, Users } from "lucide-react";
import { useAppStore } from "@/lib/store";

const ROLE_LABEL = { owner: "Owner", admin: "Administrator", user: "Member" } as const;

/** Account section for every user: who you are, change password, profile management. */
export function AccountPanel() {
  const user = useAppStore((s) => s.user);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (next.length < 8) return setMessage({ ok: false, text: "The new password needs at least 8 characters." });
    if (next !== confirm) return setMessage({ ok: false, text: "The new passwords don't match." });
    setBusy(true);
    const res = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ current, next }),
    }).catch(() => null);
    setBusy(false);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) return setMessage({ ok: false, text: data.error ?? "Could not change the password." });
    setCurrent("");
    setNext("");
    setConfirm("");
    setMessage({ ok: true, text: "Password changed. Other devices have been signed out." });
  };

  const input = "w-full rounded bg-[#333] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-white/40";

  return (
    <section id="account" className="scroll-mt-24 rounded-panel bg-surface p-6 ring-1 ring-line" data-testid="account-panel">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Account</h2>
        {user && (
          <span className="flex items-center gap-2 text-sm">
            <span className="text-netflix-light-gray">{user.name}</span>
            <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs" data-testid="account-role">
              {ROLE_LABEL[user.role ?? "user"]}
            </span>
          </span>
        )}
      </div>

      <Link href="/profiles?manage=1" className="mb-6 flex items-center gap-3 rounded border border-white/15 px-4 py-3 text-sm hover:bg-white/5">
        <Users className="h-4 w-4 text-netflix-light-gray" />
        <span>
          Manage profiles <span className="text-netflix-gray">— names, avatars, kids settings and profile PINs</span>
        </span>
      </Link>

      <form onSubmit={changePassword} className="space-y-3" aria-labelledby="change-password-heading">
        <h3 id="change-password-heading" className="flex items-center gap-2 font-medium">
          <KeyRound className="h-4 w-4" /> Change password
        </h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-netflix-light-gray">
            Current password
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={`mt-1 ${input}`} />
          </label>
          <label className="text-xs text-netflix-light-gray">
            New password
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={`mt-1 ${input}`} />
          </label>
          <label className="text-xs text-netflix-light-gray">
            Confirm new password
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={`mt-1 ${input}`} />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy || !current || !next} className="rounded bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-white/85 disabled:opacity-50">
            {busy ? "Saving…" : "Change password"}
          </button>
          {message && <p role="status" className={`text-sm ${message.ok ? "text-green-400" : "text-amber-400"}`}>{message.text}</p>}
        </div>
      </form>

    </section>
  );
}
