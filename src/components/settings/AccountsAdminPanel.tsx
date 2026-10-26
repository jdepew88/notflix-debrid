"use client";

import { useCallback, useEffect, useState } from "react";

interface AccountRow {
  id: string;
  name: string;
  displayName?: string;
  role: "owner" | "admin" | "user";
  createdAt: string;
}

const input = "w-full rounded bg-[#333] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-white/40";

/**
 * Owner/administrator view of all accounts: create accounts, roles (owner only), password resets,
 * and whether people may create their own account (owner only).
 */
export function AccountsAdminPanel() {
  const [users, setUsers] = useState<AccountRow[]>([]);
  const [you, setYou] = useState<{ id: string; role: string } | null>(null);
  const [allowSignup, setAllowSignup] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [newDisplay, setNewDisplay] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"user" | "admin">("user");

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/users", { credentials: "same-origin" }).catch(() => null);
    if (!res?.ok) return;
    const data = await res.json();
    setUsers(data.users);
    setYou({ id: data.you, role: data.yourRole });
    setAllowSignup(Boolean(data.allowSignup));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    void load();
  }, [load]);

  const act = async (body: Record<string, unknown>, success: (data: Record<string, unknown>) => string): Promise<boolean> => {
    setNotice(null);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) {
      setNotice({ ok: false, text: data.error ?? "That didn't work." });
      return false;
    }
    if (Array.isArray(data.users)) setUsers(data.users);
    if (typeof data.allowSignup === "boolean") setAllowSignup(data.allowSignup);
    setNotice({ ok: true, text: success(data) });
    return true;
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await act(
      { action: "create", name: newName.trim(), displayName: newDisplay.trim(), password: newPassword, role: newRole },
      () => `Account ${newName.trim()} created. Share the password privately; they can change it in Settings.`
    );
    if (ok) {
      setNewName("");
      setNewDisplay("");
      setNewPassword("");
      setNewRole("user");
    }
  };

  return (
    <section className="rounded-panel bg-surface p-6 ring-1 ring-line" data-testid="accounts-admin">
      <h2 className="mb-1 text-xl font-semibold">Accounts</h2>
      <p className="mb-4 text-sm text-netflix-light-gray">
        Members browse and play, and manage their own profiles. Administrators can also manage accounts. Only the owner can change server settings and
        credentials.
      </p>
      <ul className="divide-y divide-white/10">
        {users.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-3 py-3" data-testid="account-row" data-account={u.name}>
            <span className="min-w-0 flex-1 truncate">
              {u.displayName ? `${u.displayName} ` : ""}
              <span className={u.displayName ? "text-netflix-gray" : ""}>{u.displayName ? `(${u.name})` : u.name}</span>{" "}
              {u.id === you?.id && <span className="text-xs text-netflix-gray">(you)</span>}
            </span>
            <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs capitalize">{u.role === "user" ? "member" : u.role}</span>
            {you?.role === "owner" && u.role !== "owner" && (
              <button
                type="button"
                onClick={() => void act({ action: "setRole", userId: u.id, role: u.role === "admin" ? "user" : "admin" }, () => `${u.name} is now ${u.role === "admin" ? "a member" : "an administrator"}.`)}
                className="rounded border border-white/20 px-3 py-1 text-xs hover:bg-white/10"
              >
                {u.role === "admin" ? "Remove admin" : "Make admin"}
              </button>
            )}
            {u.id !== you?.id && u.role !== "owner" && (you?.role === "owner" || u.role === "user") && (
              <button
                type="button"
                onClick={() => {
                  if (!window.confirm(`Reset ${u.name}'s password? They will be signed out everywhere.`)) return;
                  void act({ action: "resetPassword", userId: u.id }, (d) => `Temporary password for ${u.name}: ${String(d.temporaryPassword)} — share it privately; they should change it after signing in.`);
                }}
                className="rounded border border-white/20 px-3 py-1 text-xs hover:bg-white/10"
              >
                Reset password
              </button>
            )}
          </li>
        ))}
      </ul>

      <form onSubmit={create} className="mt-6 space-y-3 rounded border border-white/10 p-4" data-testid="create-account">
        <h3 className="font-medium">Add an account</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-netflix-light-gray">
            Username
            <input value={newName} onChange={(e) => setNewName(e.target.value)} autoComplete="off" className={`mt-1 ${input}`} />
          </label>
          <label className="text-xs text-netflix-light-gray">
            Display name (optional)
            <input value={newDisplay} onChange={(e) => setNewDisplay(e.target.value)} autoComplete="off" className={`mt-1 ${input}`} />
          </label>
          <label className="text-xs text-netflix-light-gray">
            Initial password (8+ characters)
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" className={`mt-1 ${input}`} />
          </label>
          <label className="text-xs text-netflix-light-gray">
            Role
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as "user" | "admin")} className={`mt-1 ${input}`} disabled={you?.role !== "owner"}>
              <option value="user">Member</option>
              {you?.role === "owner" && <option value="admin">Administrator</option>}
            </select>
          </label>
        </div>
        <button type="submit" disabled={!newName.trim() || newPassword.length < 8} className="rounded bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-white/85 disabled:opacity-50">
          Create account
        </button>
      </form>

      {you?.role === "owner" && (
        <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-white"
            checked={allowSignup}
            onChange={(e) => void act({ action: "setSignup", allowSignup: e.target.checked }, (d) => (d.allowSignup ? "Anyone who can reach this server can now create an account." : "Sign-up is closed."))}
            data-testid="allow-signup"
          />
          <span>
            Let people create their own account
            <span className="block text-[13px] text-netflix-gray">Off by default. Anyone who can open Notflix could sign up while this is on.</span>
          </span>
        </label>
      )}

      {notice && (
        <p role="status" className={`mt-3 break-all rounded px-3 py-2 text-sm ${notice.ok ? "bg-green-500/10 text-green-300" : "bg-amber-500/10 text-amber-300"}`} data-testid="accounts-notice">
          {notice.text}
        </p>
      )}
    </section>
  );
}
