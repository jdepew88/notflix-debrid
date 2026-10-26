"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { NotflixWordmark } from "@/components/brand/Logo";

interface Backdrop {
  path: string;
  title: string;
}

/** Cinematic sign-in backdrop: trending artwork (slow cross-fade; static with reduced motion). */
export function AuthShell({ children }: { children: ReactNode }) {
  const [backdrops, setBackdrops] = useState<Backdrop[]>([]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/backdrops")
      .then((r) => (r.ok ? r.json() : { backdrops: [] }))
      .then((d) => {
        if (!cancelled) setBackdrops((d.backdrops ?? []).slice(0, 5));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (backdrops.length < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % backdrops.length), 9000);
    return () => clearInterval(t);
  }, [backdrops.length]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-netflix-black">
      <div className="absolute inset-0" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_20%_20%,#3b0a0e_0%,transparent_55%),radial-gradient(ellipse_at_80%_80%,#1a1030_0%,transparent_55%)]" />
        {backdrops.map((b, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- full-bleed decorative art, fades in when loaded
          <img
            key={b.path}
            src={`https://image.tmdb.org/t/p/w1280${b.path}`}
            alt=""
            className={cn(
              "absolute inset-0 h-full w-full object-cover transition-opacity duration-[2000ms]",
              i === index ? "opacity-60 animate-ken-burns" : "opacity-0"
            )}
            loading={i === 0 ? "eager" : "lazy"}
            fetchPriority={i === 0 ? "high" : "low"}
          />
        ))}
        <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-black/40 to-black/90" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_30%,rgba(0,0,0,0.65)_100%)]" />
      </div>

      <header className="relative z-10 px-5 py-5 md:px-12">
        <Link href="/" className="focus-ring inline-block rounded-sm" aria-label="Notflix home">
          <NotflixWordmark title="" className="h-7 w-auto md:h-9" />
        </Link>
      </header>

      <main className="relative z-10 flex justify-center px-4 pb-16 pt-4 md:pt-10">
        <div className="w-full max-w-[440px] animate-rise-in rounded-xl bg-black/75 px-6 py-9 shadow-2xl ring-1 ring-white/10 backdrop-blur-md sm:px-12 sm:py-12">
          {children}
        </div>
      </main>
    </div>
  );
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  name?: string;
  error?: string | null;
  hint?: string;
  autoFocus?: boolean;
  minLength?: number;
}

const inputClass =
  "peer w-full rounded-md bg-[#333]/90 px-4 pb-2 pt-6 text-white ring-1 ring-white/10 transition placeholder:text-transparent focus:bg-[#454545] focus:outline-none focus:ring-2 focus:ring-white/70 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-amber-500";
const labelClass =
  "pointer-events-none absolute left-4 top-4 origin-left text-[15px] text-netflix-light-gray transition-all peer-focus:top-1.5 peer-focus:text-xs peer-[:not(:placeholder-shown)]:top-1.5 peer-[:not(:placeholder-shown)]:text-xs";

export function TextField({ id, label, value, onChange, autoComplete, name, error, hint, autoFocus }: FieldProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <div className="relative">
        <input
          id={id}
          name={name}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          placeholder={label}
          autoFocus={autoFocus}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          className={inputClass}
        />
        <label htmlFor={id} className={labelClass}>
          {label}
        </label>
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-[13px] text-amber-400">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-[13px] text-netflix-gray">{hint}</p>
      ) : null}
    </div>
  );
}

export function PasswordField({ id, label, value, onChange, autoComplete, name, error, hint, minLength }: FieldProps) {
  const [visible, setVisible] = useState(false);
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          placeholder={label}
          minLength={minLength}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          className={cn(inputClass, "pr-14")}
        />
        <label htmlFor={id} className={labelClass}>
          {label}
        </label>
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          aria-controls={id}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-2 text-netflix-light-gray hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          {visible ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-[13px] text-amber-400">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-[13px] text-netflix-gray">{hint}</p>
      ) : null}
    </div>
  );
}

export function SubmitButton({ loading, children, loadingText }: { loading: boolean; children: ReactNode; loadingText: string }) {
  return (
    <button
      type="submit"
      disabled={loading}
      aria-busy={loading}
      className="flex w-full items-center justify-center gap-2 rounded-md bg-netflix-red py-3 font-semibold transition hover:bg-netflix-red-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-wait disabled:opacity-80"
    >
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />}
      {loading ? loadingText : children}
    </button>
  );
}

export function RememberMe({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-netflix-light-gray">
      <input type="hidden" name="rememberPresent" value="1" />
      <input
        type="checkbox"
        name="remember"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-white"
      />
      Remember me
    </label>
  );
}
