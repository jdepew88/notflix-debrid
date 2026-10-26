"use client";

import type { ReactNode } from "react";
import { CheckCircle2, AlertTriangle, XCircle, Info } from "lucide-react";
import { cn } from "@/lib/cn";

/** Small form kit for the setup wizard and the owner's Settings page. */

export const fieldClass =
  "w-full rounded-md bg-[#2a2a2a] px-3 py-2.5 text-white ring-1 ring-white/15 placeholder:text-white/35 focus:outline-none focus:ring-2 focus:ring-white/70 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-amber-500 disabled:opacity-60";

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-white">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-[13px] text-amber-400" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[13px] leading-relaxed text-netflix-gray">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Toggle({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label htmlFor={id} className={cn("flex cursor-pointer items-start gap-3 rounded-md p-1", disabled && "cursor-not-allowed opacity-60")}>
      <input
        id={id}
        type="checkbox"
        className="mt-1 h-4 w-4 shrink-0 accent-white"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="block text-sm font-medium text-white">{label}</span>
        {description && <span className="mt-0.5 block text-[13px] leading-relaxed text-netflix-gray">{description}</span>}
      </span>
    </label>
  );
}

type Tone = "ok" | "warn" | "error" | "info";

const toneIcon: Record<Tone, ReactNode> = {
  ok: <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />,
  warn: <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />,
  error: <XCircle className="h-4 w-4 shrink-0 text-red-400" aria-hidden />,
  info: <Info className="h-4 w-4 shrink-0 text-sky-300" aria-hidden />,
};

export function Notice({ tone = "info", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-2.5 rounded-md px-3 py-2.5 text-[13px] leading-relaxed ring-1",
        tone === "ok" && "bg-emerald-950/40 text-emerald-100 ring-emerald-500/30",
        tone === "warn" && "bg-amber-950/40 text-amber-100 ring-amber-500/30",
        tone === "error" && "bg-red-950/40 text-red-100 ring-red-500/30",
        tone === "info" && "bg-white/5 text-netflix-light-gray ring-white/10",
        className
      )}
    >
      <span className="mt-0.5">{toneIcon[tone]}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Pill({ tone, children }: { tone: Tone | "muted"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        tone === "ok" && "bg-emerald-500/15 text-emerald-300",
        tone === "warn" && "bg-amber-500/15 text-amber-300",
        tone === "error" && "bg-red-500/15 text-red-300",
        tone === "info" && "bg-sky-500/15 text-sky-300",
        tone === "muted" && "bg-white/10 text-netflix-gray"
      )}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  busy,
  disabled,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-60",
        variant === "primary" && "bg-netflix-red text-white hover:bg-netflix-red-hover",
        variant === "secondary" && "bg-white/10 text-white ring-1 ring-white/15 hover:bg-white/20",
        variant === "ghost" && "text-netflix-light-gray hover:bg-white/10 hover:text-white",
        variant === "danger" && "bg-red-950/60 text-red-200 ring-1 ring-red-500/40 hover:bg-red-900/60",
        className
      )}
    >
      {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />}
      {children}
    </button>
  );
}

export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        {description && <div className="mt-1 text-sm leading-relaxed text-netflix-light-gray">{description}</div>}
      </div>
      {children}
    </section>
  );
}

/** JSON request helper: returns parsed body and status; never throws on HTTP errors. */
export async function api<T = Record<string, unknown>>(
  url: string,
  init: { method?: string; body?: unknown } = {}
): Promise<{ ok: boolean; status: number; data: T & { error?: string; errors?: Record<string, string> } }> {
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; errors?: Record<string, string> };
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "Could not reach the Notflix server." } as T & { error?: string } };
  }
}
