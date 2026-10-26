"use client";

import { useId, useState } from "react";
import { Lock, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { ProfileAvatar } from "./ProfileAvatar";
import type { UserProfile } from "@/lib/types";

interface PinDialogProps {
  profile: UserProfile;
  /** Returns an error message to show, or null on success. */
  onSubmit: (pin: string) => Promise<string | null>;
  onClose: () => void;
  purpose?: string;
}

/** Four-digit profile PIN entry. Submits automatically once four digits are typed. */
export function PinDialog({ profile, onSubmit, onClose, purpose = "Enter your PIN to open this profile." }: PinDialogProps) {
  const titleId = useId();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (value: string) => {
    if (busy || value.length !== 4) return;
    setBusy(true);
    const problem = await onSubmit(value);
    setBusy(false);
    if (problem) {
      setError(problem);
      setPin("");
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      labelledBy={titleId}
      testId="pin-dialog"
      overlayClassName="flex items-center justify-center p-4"
      className="w-full max-w-sm animate-rise-in rounded-2xl bg-[#181818] p-7 text-center shadow-2xl ring-1 ring-white/10"
    >
      <button type="button" onClick={onClose} aria-label="Cancel" className="absolute right-3 top-3 rounded-full p-2 text-white/60 hover:bg-white/10 hover:text-white">
        <X className="h-5 w-5" />
      </button>
      <ProfileAvatar avatar={profile.avatar} name={profile.name} size={72} className="mx-auto rounded-lg" decorative />
      <h2 id={titleId} className="mt-4 flex items-center justify-center gap-2 text-lg font-semibold">
        <Lock className="h-4 w-4" /> {profile.name}
      </h2>
      <p className="mt-1 text-sm text-netflix-light-gray">{purpose}</p>
      <form
        className="mt-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(pin);
        }}
      >
        <label className="sr-only" htmlFor={`${titleId}-pin`}>Profile PIN</label>
        <input
          id={`${titleId}-pin`}
          data-autofocus
          data-testid="pin-input"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={pin}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${titleId}-err` : undefined}
          onChange={(e) => {
            const value = e.target.value.replace(/\D/g, "").slice(0, 4);
            setPin(value);
            setError(null);
            if (value.length === 4) void submit(value);
          }}
          className="w-44 rounded-lg bg-[#2a2a2a] px-4 py-3 text-center text-2xl tracking-[0.8em] ring-1 ring-white/15 focus:outline-none focus:ring-2 focus:ring-white/70"
        />
        <div className="mt-3 flex justify-center gap-2" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`h-2 w-2 rounded-full ${i < pin.length ? "bg-white" : "bg-white/25"}`} />
          ))}
        </div>
        {error && (
          <p id={`${titleId}-err`} role="alert" className="mt-3 text-sm text-red-300">
            {error}
          </p>
        )}
        {busy && <p className="mt-3 text-sm text-netflix-light-gray">Checking…</p>}
      </form>
    </Dialog>
  );
}
