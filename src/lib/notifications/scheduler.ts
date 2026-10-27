/**
 * Lightweight persistent scheduler for the notification jobs.
 *
 * - One process at a time: a lease in <data>/db/notifications/lease.json (owner id + expiry,
 *   changed under a file lock). A second Notflix process on the same data folder (or a future
 *   container replica) sees a live lease and stays idle; if the holder dies, the lease expires
 *   and another process takes over.
 * - No overlap: one job at a time per process, and only while the lease is held (renewed between
 *   jobs). A long job keeps the lease by renewing it.
 * - Survives restarts: each job's last/next run and failures are stored in state.json; jobs that
 *   became due while Notflix was off run once after startup (missed runs are not replayed).
 * - Failures back off: 15 min, 30 min, 1 h … up to the job's normal interval. After three
 *   failures in a row the owner gets a service notification; it clears when the job succeeds.
 * - Never delays startup: the first check happens a while after start, and everything runs in
 *   the background with timers that do not keep the process alive.
 */
import crypto from "node:crypto";
import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "../install/store.mjs";
import { JOBS, deliverServiceNotice, dispatchPushes, readState, updateState, type JobContext, type JobName } from "./jobs";
import { TmdbAuthError } from "./tmdb-client";

export const LEASE_MS = 5 * 60_000;
export const TICK_MS = 60_000;
const BACKOFF_BASE_MS = 15 * 60_000;
export const FAILURE_NOTICE_AFTER = 3;

interface Lease {
  owner: string;
  pid: number;
  expiresAt: number;
}

const leaseFile = (dir: string) => path.join(dir, "lease.json");

/** Takes or renews the lease; false while another live process holds it. */
export function acquireLease(dir: string, owner: string, now: number, ttlMs = LEASE_MS): boolean {
  return withFileLock(`${leaseFile(dir)}.lock`, () => {
    const current = readJson(leaseFile(dir), null) as Lease | null;
    if (current && current.owner !== owner && current.expiresAt > now) return false;
    writeJsonAtomic(leaseFile(dir), { owner, pid: process.pid, expiresAt: now + ttlMs } satisfies Lease);
    return true;
  });
}

export function releaseLease(dir: string, owner: string): void {
  withFileLock(`${leaseFile(dir)}.lock`, () => {
    const current = readJson(leaseFile(dir), null) as Lease | null;
    if (current?.owner === owner) writeJsonAtomic(leaseFile(dir), { ...current, expiresAt: 0 });
  });
}

export function backoffMs(failures: number, intervalMs: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), intervalMs);
}

export interface SchedulerOptions {
  ctx: () => JobContext | null;
  owner?: string;
  /** Jobs to run (default: all). */
  jobs?: JobName[];
  log?: (message: string) => void;
}

export class NotificationScheduler {
  readonly owner: string;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: SchedulerOptions) {
    this.owner = opts.owner ?? `${process.pid}-${crypto.randomUUID()}`;
  }

  /** Starts ticking after `delayMs`, then every `intervalMs`. Timers never keep the process alive. */
  start(delayMs: number, intervalMs = TICK_MS): void {
    if (this.timer || this.startTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.tick();
      this.timer = setInterval(() => void this.tick(), intervalMs);
      this.timer.unref?.();
    }, delayMs);
    this.startTimer.unref?.();
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.timer) clearInterval(this.timer);
    this.startTimer = this.timer = null;
    const ctx = this.opts.ctx();
    if (ctx) {
      try {
        releaseLease(ctx.dir, this.owner);
      } catch {
        /* best effort */
      }
    }
  }

  /** One scheduling pass. Concurrent calls share the pass in progress (no overlapping jobs). */
  tick(only?: JobName): Promise<void> {
    if (this.running) return this.running;
    this.running = this.pass(only).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Runs one job now (owner request), still under the lease and never alongside another job. */
  async runNow(job: JobName): Promise<{ ran: boolean; reason?: string }> {
    const ctx = this.opts.ctx();
    if (!ctx) return { ran: false, reason: "Notifications are not available (setup not finished)." };
    if (this.running) await this.running.catch(() => {});
    updateState(ctx.dir, (s) => {
      s.jobs[job] = { ...(s.jobs[job] ?? { failures: 0 }), nextRunAt: new Date(0).toISOString() };
    });
    let ran = false;
    const before = readState(ctx.dir).jobs[job]?.lastRunAt;
    await this.tick(job);
    ran = readState(ctx.dir).jobs[job]?.lastRunAt !== before;
    return ran ? { ran } : { ran, reason: "Another Notflix process is running the notification jobs." };
  }

  private async pass(only?: JobName): Promise<void> {
    const ctx = this.opts.ctx();
    if (!ctx) return;
    const log = this.opts.log ?? ctx.log;
    const now = () => ctx.now().getTime();
    if (!acquireLease(ctx.dir, this.owner, now())) return;
    const names = (only ? [only] : this.opts.jobs ?? (Object.keys(JOBS) as JobName[])).filter((n) => n in JOBS);
    for (const name of names) {
      const job = JOBS[name];
      const state = readState(ctx.dir).jobs[name];
      if (state?.nextRunAt && Date.parse(state.nextRunAt) > now()) continue;
      if (!acquireLease(ctx.dir, this.owner, now())) return;
      const started = new Date(now()).toISOString();
      try {
        const outcome = await job.run(ctx);
        const done = new Date(now());
        updateState(ctx.dir, (s) => {
          const wasFailing = (s.jobs[name]?.failures ?? 0) >= FAILURE_NOTICE_AFTER;
          s.jobs[name] = { lastRunAt: started, lastSuccessAt: done.toISOString(), nextRunAt: new Date(done.getTime() + job.intervalMs).toISOString(), failures: 0, lastSummary: outcome.summary };
          if (wasFailing) delete s.service[`job-${name}`];
        });
        log(`notifications: ${name}: ${outcome.summary}`);
      } catch (err) {
        const message = err instanceof TmdbAuthError ? "TMDB rejected the stored key" : err instanceof Error ? err.message : String(err);
        const failed = new Date(now());
        const failures = updateState(ctx.dir, (s) => {
          const f = (s.jobs[name]?.failures ?? 0) + 1;
          s.jobs[name] = {
            ...s.jobs[name],
            lastRunAt: started,
            failures: f,
            lastError: message.slice(0, 300),
            nextRunAt: new Date(failed.getTime() + backoffMs(f, job.intervalMs)).toISOString(),
          };
          return f;
        });
        log(`notifications: ${name} failed (${failures} in a row): ${message}`);
        if (failures >= FAILURE_NOTICE_AFTER || err instanceof TmdbAuthError) this.noticeFailure(ctx, name, err instanceof TmdbAuthError);
      }
    }
    try {
      const r = await dispatchPushes(ctx);
      if (r.sent || r.skipped) log(`notifications: browser push: ${r.sent} sent, ${r.held} held (quiet hours), ${r.skipped} skipped`);
    } catch (err) {
      log(`notifications: browser push failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private noticeFailure(ctx: JobContext, name: JobName, auth: boolean) {
    const id = auth ? "tmdb-rejected" : `job-${name}`;
    const since = updateState(ctx.dir, (s) => (s.service[id] ??= ctx.now().toISOString().slice(0, 10)));
    deliverServiceNotice(
      ctx,
      auth
        ? { id, message: "TMDB rejected the stored key, so new episodes and releases cannot be checked. Paste a new key.", href: "/settings/wizard#metadata" }
        : { id, message: `The background check for ${name === "series" ? "new episodes" : name} keeps failing (TMDB unreachable?). In-app notifications resume automatically.`, href: "/settings#notifications" },
      since
    );
  }
}
