"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAppStore } from "@/lib/store";
import { completeClientAuth } from "@/lib/auth-client";
import { AuthShell, PasswordField, RememberMe, SubmitButton, TextField } from "@/components/auth/AuthShell";

export default function LoginPage() {
  const setUser = useAppStore((s) => s.setUser);
  const hydrateUserState = useAppStore((s) => s.hydrateUserState);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; password?: string }>({});
  const [showRecovery, setShowRecovery] = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);

  useEffect(() => {
    fetch("/api/setup/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setSignupOpen(Boolean(d?.signupOpen)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const queryError = params.get("error");
    // Messages from the no-JavaScript form post fallback.
    if (queryError === "invalid") setError("Incorrect username or password.");
    else if (queryError) setError(queryError.slice(0, 200));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: typeof fieldErrors = {};
    if (!name.trim()) errors.name = "Enter your username.";
    if (!password) errors.password = "Enter your password.";
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;

    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, password, remember }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sign-in failed. Try again.");
      const next = new URLSearchParams(window.location.search).get("next");
      // Always choose a profile first; then continue to where the user was going.
      const redirectTo = next && next.startsWith("/") && !next.startsWith("//") ? `/profiles?next=${encodeURIComponent(next)}` : "/profiles";
      await completeClientAuth(data.user, setUser, hydrateUserState, redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Try again.");
      setPassword("");
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <h1 className="mb-7 text-3xl font-bold">Sign in</h1>
      <form method="post" action="/api/auth/login" onSubmit={handleSubmit} noValidate className="space-y-4">
        {error && (
          <div role="alert" className="rounded-md bg-amber-500/90 px-4 py-3 text-sm font-medium text-black" data-testid="auth-error">
            {error}
          </div>
        )}
        <TextField id="login-name" name="name" label="Username" value={name} onChange={setName} autoComplete="username" error={fieldErrors.name} autoFocus />
        <PasswordField id="login-password" name="password" label="Password" value={password} onChange={setPassword} autoComplete="current-password" error={fieldErrors.password} />
        <SubmitButton loading={loading} loadingText="Signing in…">Sign in</SubmitButton>
        <div className="flex items-center justify-between">
          <RememberMe checked={remember} onChange={setRemember} />
          <button type="button" onClick={() => setShowRecovery((v) => !v)} aria-expanded={showRecovery} className="text-sm text-netflix-light-gray hover:text-white hover:underline">
            Forgot password?
          </button>
        </div>
        {showRecovery && (
          <p className="rounded-md bg-white/5 p-3 text-[13px] leading-relaxed text-netflix-light-gray ring-1 ring-white/10">
            Ask the server owner to reset it in <span className="text-white">Settings → Accounts</span>. They get a temporary password to give you; change it after signing in.
          </p>
        )}
      </form>
      {signupOpen ? (
        <p className="mt-10 text-netflix-gray">
          New to Notflix?{" "}
          <Link href="/signup" className="font-medium text-white hover:underline">
            Create an account
          </Link>
        </p>
      ) : (
        <p className="mt-10 text-sm text-netflix-gray" data-testid="signup-closed">
          Need an account? Ask the person who runs this Notflix server to add you.
        </p>
      )}
      <p className="mt-3 text-xs text-netflix-gray">{remember ? "You'll stay signed in on this device for 30 days." : "You'll be signed out when you close the browser."}</p>
    </AuthShell>
  );
}
