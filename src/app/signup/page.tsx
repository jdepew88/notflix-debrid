"use client";

import { useState } from "react";
import Link from "next/link";
import { useAppStore } from "@/lib/store";
import { completeClientAuth } from "@/lib/auth-client";
import { AuthShell, PasswordField, RememberMe, SubmitButton, TextField } from "@/components/auth/AuthShell";

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,31}$/u;

export default function SignUpPage() {
  const setUser = useAppStore((s) => s.setUser);
  const hydrateUserState = useAppStore((s) => s.hydrateUserState);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; password?: string; confirm?: string }>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: typeof fieldErrors = {};
    if (!NAME_RE.test(name.trim())) errors.name = "2–32 characters: letters, numbers, spaces, dots, dashes or underscores.";
    if (password.length < 8) errors.password = "Use at least 8 characters.";
    if (confirm !== password) errors.confirm = "Passwords don't match.";
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;

    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim(), password, remember }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not create the account.");
      await completeClientAuth(data.user, setUser, hydrateUserState);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the account.");
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <h1 className="mb-2 text-3xl font-bold">Create your account</h1>
      <p className="mb-7 text-sm text-netflix-light-gray">One account, up to 8 profiles. No email needed.</p>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {error && (
          <div role="alert" className="rounded-md bg-amber-500/90 px-4 py-3 text-sm font-medium text-black" data-testid="auth-error">
            {error}
          </div>
        )}
        <TextField id="signup-name" label="Username" value={name} onChange={setName} autoComplete="username" error={fieldErrors.name} autoFocus />
        <PasswordField
          id="signup-password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          error={fieldErrors.password}
          hint={password.length > 0 && password.length < 8 ? `${8 - password.length} more character${8 - password.length === 1 ? "" : "s"}` : "At least 8 characters."}
        />
        <PasswordField id="signup-confirm" label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={fieldErrors.confirm} />
        <SubmitButton loading={loading} loadingText="Creating account…">Create account</SubmitButton>
        <RememberMe checked={remember} onChange={setRemember} />
      </form>
      <p className="mt-6 text-[13px] leading-relaxed text-netflix-gray">
        There is no email recovery. If you forget your password, the server owner can reset it.
      </p>
      <p className="mt-8 text-netflix-gray">
        Already have an account?{" "}
        <Link href="/" className="font-medium text-white hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
