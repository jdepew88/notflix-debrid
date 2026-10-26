"use client";

import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";
import { NotflixWordmark } from "@/components/brand/Logo";
import { PasswordField, TextField } from "@/components/auth/AuthShell";
import { DebridPanel, HardwarePanel, MetadataPanel, ServerPanel, SummaryList, type InstallSummary } from "@/components/setup/ConfigPanels";
import { Button, Notice, api, fieldClass } from "@/components/setup/ui";
import { cn } from "@/lib/cn";

type StepId = "welcome" | "server" | "owner" | "metadata" | "debrid" | "hardware" | "finish";

/**
 * "first-run": the /setup wizard (setup code, owner creation, then configuration).
 * "reconfigure": the same steps for the signed-in owner after setup (Settings -> Run setup again);
 * no owner step, nothing is reset, and every new value is validated before it replaces the old one.
 */
export type WizardMode = "first-run" | "reconfigure";

const ALL_STEPS: Array<{ id: StepId; label: string }> = [
  { id: "server", label: "Server" },
  { id: "owner", label: "Owner account" },
  { id: "metadata", label: "TMDB" },
  { id: "debrid", label: "Real-Debrid" },
  { id: "hardware", label: "Hardware" },
  { id: "finish", label: "Finish" },
];

const stepsFor = (mode: WizardMode) => (mode === "reconfigure" ? ALL_STEPS.filter((s) => s.id !== "owner") : ALL_STEPS);

interface SetupStatus {
  setupComplete: boolean;
  ownerExists: boolean;
  unlocked: boolean;
  signedInAsOwner: boolean;
  stepsDone: string[];
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,31}$/u;

function Stepper({ current, done, onPick, free, mode }: { current: StepId; done: Set<string>; onPick: (id: StepId) => void; free: boolean; mode: WizardMode }) {
  return (
    <ol className="mb-8 flex flex-wrap gap-x-1 gap-y-2 text-[13px]" aria-label="Setup steps">
      {stepsFor(mode).map((s, i) => {
        const isDone = done.has(s.id);
        const active = s.id === current;
        // Once the owner exists, every later step can be revisited in any order.
        const reachable = free || isDone || active;
        return (
          <li key={s.id} className="flex items-center gap-1">
            <button
              type="button"
              disabled={!reachable || s.id === "owner"}
              onClick={() => onPick(s.id)}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 transition",
                active ? "bg-white text-black" : isDone ? "bg-white/10 text-white hover:bg-white/20" : "text-netflix-gray"
              )}
            >
              <span className={cn("flex h-4 w-4 items-center justify-center rounded-full text-[10px]", active ? "bg-black text-white" : isDone ? "bg-emerald-500 text-black" : "bg-white/15")}>
                {isDone && !active ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              {s.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function SetupWizard({ mode }: { mode: WizardMode }) {
  const reconfigure = mode === "reconfigure";
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState<StepId>(reconfigure ? "server" : "welcome");
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async (advance = true) => {
    const { ok, data } = await api<SetupStatus>("/api/setup/status");
    if (!ok) {
      setLoadError(data.error ?? "Could not reach the Notflix server.");
      return null;
    }
    setStatus(data);
    if (reconfigure) return data;
    if (advance) {
      // Resumes where an interrupted setup stopped (the completed steps are stored on the server).
      if (data.setupComplete) setStep("finish");
      else if (!data.ownerExists) setStep(data.unlocked ? (data.stepsDone.includes("server") ? "owner" : "server") : "welcome");
      else if (!data.signedInAsOwner) setStep("owner");
      else setStep((["metadata", "debrid", "hardware"] as StepId[]).find((s) => !data.stepsDone.includes(s)) ?? "finish");
    }
    return data;
  }, [reconfigure]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data when mounted / inputs change
    void refresh();
  }, [refresh]);

  // Settings and the owner banner link straight to a step: /settings/wizard#debrid
  useEffect(() => {
    if (!reconfigure) return;
    const wanted = window.location.hash.slice(1) as StepId;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the URL once when mounted
    if (stepsFor(mode).some((s) => s.id === wanted)) setStep(wanted);
  }, [reconfigure, mode]);

  const done = new Set(status?.stepsDone ?? []);
  if (status?.ownerExists) done.add("owner");

  const next = (from: StepId) => {
    const order = stepsFor(mode).map((s) => s.id);
    void refresh(false).then(() => setStep(order[Math.min(order.indexOf(from) + 1, order.length - 1)]));
  };

  return (
    <div className="relative min-h-screen bg-netflix-black">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_15%_10%,#3b0a0e_0%,transparent_50%),radial-gradient(ellipse_at_85%_90%,#151030_0%,transparent_55%)]" aria-hidden />
      <header className="relative z-10 px-5 py-5 md:px-12">
        <NotflixWordmark title="Notflix" className="h-7 w-auto md:h-9" />
      </header>
      <main className="relative z-10 flex justify-center px-4 pb-16">
        <div className="w-full max-w-3xl rounded-xl bg-black/70 px-5 py-8 shadow-2xl ring-1 ring-white/10 backdrop-blur-md sm:px-10 sm:py-10">
          {loadError && <Notice tone="error">{loadError}</Notice>}
          {!status && !loadError && <p className="text-netflix-light-gray">Loading…</p>}
          {status && reconfigure && !status.signedInAsOwner && (
            <Notice tone="error">
              Only the owner can change the server configuration.{" "}
              <a className="underline" href="/settings">
                Back to Settings
              </a>
            </Notice>
          )}
          {status && reconfigure && status.signedInAsOwner && step === "server" && (
            <Notice className="mb-6">
              You are changing an installed server. Your accounts, profiles and watch history stay as they are, and stored keys are only replaced after the new
              ones are checked.
            </Notice>
          )}
          {status && (!reconfigure || status.signedInAsOwner) && (
            <WizardSteps status={status} step={step} setStep={setStep} done={done} next={next} refresh={refresh} mode={mode} />
          )}
        </div>
      </main>
    </div>
  );
}

function WizardSteps({
  status,
  step,
  setStep,
  done,
  next,
  refresh,
  mode,
}: {
  status: SetupStatus;
  step: StepId;
  setStep: (s: StepId) => void;
  done: Set<string>;
  next: (from: StepId) => void;
  refresh: (advance?: boolean) => Promise<SetupStatus | null>;
  mode: WizardMode;
}) {
  return (
    <>
          {step !== "welcome" && <Stepper current={step} done={done} onPick={setStep} free={status.ownerExists && status.signedInAsOwner} mode={mode} />}

          {step === "welcome" && <WelcomeStep onUnlocked={() => void refresh()} />}

          {step === "server" && (
            <StepFrame title="Server" lead="Where Notflix listens and where it keeps its files. The defaults are safe; you can change all of this later in Settings.">
              <ServerPanel mode="setup" onSaved={() => next("server")} />
            </StepFrame>
          )}

          {step === "owner" && mode === "first-run" && (
            <StepFrame
              title={status.ownerExists ? "Sign in as the owner" : "Create the owner account"}
              lead={
                status.ownerExists
                  ? "The owner account already exists. Sign in with it to finish setup."
                  : "This account owns the server: only it can change settings and credentials. You can add accounts for other people later."
              }
            >
              {status.ownerExists ? <OwnerSignIn onDone={() => void refresh()} /> : <OwnerForm onDone={() => void refresh()} />}
            </StepFrame>
          )}

          {step === "metadata" && (
            <StepFrame title="TMDB (movie and TV information)" lead="Titles, posters, descriptions and episode lists come from TMDB. You need a free TMDB account.">
              <MetadataPanel mode="setup" onSaved={() => next("metadata")} />
            </StepFrame>
          )}

          {step === "debrid" && (
            <StepFrame title="Real-Debrid" lead="Notflix plays video through your own Real-Debrid account (a paid service you sign up for yourself).">
              <DebridPanel mode="setup" onSaved={() => next("debrid")} />
            </StepFrame>
          )}

          {step === "hardware" && (
            <StepFrame
              title="Graphics card (hardware acceleration)"
              lead="When a TV or browser can't play a file as it is, Notflix converts it. A graphics card does that faster; without one, the processor does it. Automatic is right for almost everyone."
            >
              <HardwarePanel mode="setup" onSaved={() => next("hardware")} />
            </StepFrame>
          )}

          {step === "finish" && <FinishStep complete={status.setupComplete} onBack={(s) => setStep(s)} mode={mode} />}
    </>
  );
}

function StepFrame({ title, lead, children }: { title: string; lead: string; children: React.ReactNode }) {
  return (
    <section>
      <h1 className="text-2xl font-bold text-white md:text-3xl">{title}</h1>
      <p className="mb-6 mt-2 text-sm leading-relaxed text-netflix-light-gray">{lead}</p>
      {children}
    </section>
  );
}

function WelcomeStep({ onUnlocked }: { onUnlocked: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The launcher opens /setup#code=XXXX-XXXX-XXXX; the fragment never reaches the server or logs.
  useEffect(() => {
    const m = /code=([A-Za-z0-9-]{12,20})/.exec(window.location.hash);
    if (m) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data when mounted / inputs change
      setCode(m[1].toUpperCase());
      history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const unlock = async () => {
    setBusy(true);
    setError(null);
    const { ok, data } = await api("/api/setup/unlock", { method: "POST", body: { code } });
    setBusy(false);
    if (!ok) setError(data.error ?? "That didn't work.");
    else onUnlocked();
  };

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white md:text-4xl">Welcome to Notflix Debrid</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-netflix-light-gray">
          Notflix is a self-hosted streaming app that runs on your own computer. Over the next few steps you&apos;ll choose how it can be reached, create the owner
          account, and connect the services it uses.
        </p>
      </div>
      <Notice tone="warn">
        <strong className="text-white">Notflix does not supply any movies, shows or media libraries, and comes with no accounts.</strong> It shows a catalog from
        TMDB and plays files through a Real-Debrid account that you provide. You are responsible for having the accounts you use and lawful access to anything
        you watch.
      </Notice>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void unlock();
        }}
      >
        <div className="space-y-1.5">
          <label htmlFor="setup-code" className="block text-sm font-medium text-white">
            Setup code
          </label>
          <input
            id="setup-code"
            className={cn(fieldClass, "font-mono tracking-widest")}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX-XXXX"
            autoComplete="one-time-code"
            spellCheck={false}
            autoFocus
          />
          <p className="text-[13px] leading-relaxed text-netflix-gray">
            Proves you control this server. It is shown in the Notflix launcher window and saved in <code>setup-code.txt</code> in the Notflix data folder
            (on Windows: <code>%ProgramData%\NotflixDebrid</code>).
          </p>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end">
          <Button type="submit" busy={busy} disabled={code.replace(/[^A-Z0-9]/gi, "").length < 12}>
            Start setup
          </Button>
        </div>
      </form>
    </section>
  );
}

function OwnerForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ name?: string; password?: string; confirm?: string; displayName?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const e: typeof errors = {};
    if (!NAME_RE.test(name.trim())) e.name = "2–32 characters: letters, numbers, spaces, dots, dashes or underscores.";
    if (displayName.trim().length > 40) e.displayName = "Up to 40 characters.";
    if (password.length < 8) e.password = "Use at least 8 characters.";
    if (confirm !== password) e.confirm = "Passwords don't match.";
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    const { ok, data } = await api("/api/setup/owner", { method: "POST", body: { name: name.trim(), displayName: displayName.trim(), password, confirm } });
    setBusy(false);
    if (!ok) setError(data.error ?? "Could not create the account.");
    else onDone();
  };

  return (
    <form
      className="max-w-md space-y-4"
      onSubmit={(ev) => {
        ev.preventDefault();
        void submit();
      }}
      noValidate
    >
      <TextField id="owner-name" label="Username" value={name} onChange={setName} autoComplete="username" error={errors.name} autoFocus />
      <TextField id="owner-display" label="Display name (optional)" value={displayName} onChange={setDisplayName} autoComplete="name" error={errors.displayName} hint="Shown in the app instead of the username." />
      <PasswordField id="owner-password" label="Password" value={password} onChange={setPassword} autoComplete="new-password" error={errors.password} hint="At least 8 characters. A long passphrase is best." />
      <PasswordField id="owner-confirm" label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={errors.confirm} />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end">
        <Button type="submit" busy={busy}>
          Create owner account
        </Button>
      </div>
    </form>
  );
}

function OwnerSignIn({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ user?: { role: string } }>("/api/auth/login", { method: "POST", body: { name, password, remember: true } });
    setBusy(false);
    if (!ok) return setError(data.error ?? "Sign-in failed.");
    if (data.user?.role !== "owner") return setError("That account is not the owner.");
    onDone();
  };
  return (
    <form
      className="max-w-md space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TextField id="si-name" label="Username" value={name} onChange={setName} autoComplete="username" autoFocus />
      <PasswordField id="si-password" label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end">
        <Button type="submit" busy={busy}>
          Sign in
        </Button>
      </div>
    </form>
  );
}

function FinishStep({ complete, onBack, mode }: { complete: boolean; onBack: (s: StepId) => void; mode: WizardMode }) {
  const [summary, setSummary] = useState<InstallSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<InstallSummary>("/api/config/summary?refresh=0");
    if (ok) setSummary(data);
    else setError(data.error ?? "Could not load the summary.");
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data when mounted / inputs change
    void load();
  }, [load]);

  const finish = async () => {
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ missing?: Array<{ label: string; detail: string }> }>("/api/setup/complete", { method: "POST", body: {} });
    if (!ok) {
      setBusy(false);
      setError(data.missing?.length ? `Not ready: ${data.missing.map((m) => `${m.label} — ${m.detail}`).join("; ")}` : data.error ?? "Could not finish setup.");
      void load();
      return;
    }
    window.location.href = "/profiles";
  };

  const stepFor: Record<string, StepId> = { owner: "owner", metadata: "metadata", debrid: "debrid", sources: "debrid", engine: "hardware", ffmpeg: "hardware" };
  const missing = summary?.requirements.filter((r) => !r.ok) ?? [];

  return (
    <StepFrame
      title={mode === "reconfigure" ? "Configuration" : complete ? "Setup is complete" : "Ready to finish"}
      lead={mode === "reconfigure" ? "Here is how this Notflix server is configured now." : "Here is how this Notflix server is configured. Everything can be changed later in Settings."}
    >
      {!summary && !error && <p className="text-netflix-light-gray">Loading…</p>}
      {summary && <SummaryList summary={summary} />}
      {missing.length > 0 && (
        <div className="mt-6 space-y-2">
          {missing.map((r) => (
            <Notice key={r.id} tone="error">
              <span className="text-white">{r.label}:</span> {r.detail}{" "}
              <button type="button" className="underline" onClick={() => onBack(stepFor[r.id] ?? "server")}>
                Fix
              </button>
            </Notice>
          ))}
        </div>
      )}
      {error && <Notice tone="error" className="mt-4">{error}</Notice>}
      <div className="mt-8 flex flex-wrap justify-end gap-2">
        {mode === "reconfigure" ? (
          <>
            <Button variant="secondary" onClick={() => void load()}>
              Check again
            </Button>
            <Button onClick={() => (window.location.href = "/settings")}>Done</Button>
          </>
        ) : complete ? (
          <Button onClick={() => (window.location.href = "/profiles")}>Go to Notflix</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => void load()}>
              Check again
            </Button>
            <Button busy={busy} disabled={!summary || missing.length > 0} onClick={() => void finish()}>
              Finish setup
            </Button>
          </>
        )}
      </div>
    </StepFrame>
  );
}
