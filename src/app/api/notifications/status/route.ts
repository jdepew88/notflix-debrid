import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { JOBS, readState, type JobName } from "@/lib/notifications/jobs";
import { notificationsDir, scheduler } from "@/lib/notifications/server";
import { RUN_JOBS_PER_USER, crossSiteRefusal, limited } from "@/lib/notifications/http";
import { secrets } from "@/lib/install/runtime";

export const dynamic = "force-dynamic";

/** Background-job status for the owner and administrators (no titles, accounts or credentials). */
export async function GET() {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const state = readState(notificationsDir());
  return NextResponse.json({
    tmdb: Boolean(secrets().tmdbApiKey),
    disabled: /^(0|false|off|no)$/i.test(process.env.NOTFLIX_NOTIFICATIONS ?? ""),
    jobs: Object.fromEntries(
      (Object.keys(JOBS) as JobName[]).map((name) => [name, { intervalHours: JOBS[name].intervalMs / 3_600_000, ...(state.jobs[name] ?? { failures: 0 }) }])
    ),
    tracked: { series: Object.keys(state.series).length, films: Object.keys(state.movies).length },
  });
}

/** { job } runs one background job now (still one at a time, under the lease). */
export async function POST(request: NextRequest) {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const tooMany = limited(request, admin.user.id, "run", RUN_JOBS_PER_USER);
  if (tooMany) return tooMany;
  const body = (await request.json().catch(() => ({}))) as { job?: unknown };
  const job = (Object.keys(JOBS) as JobName[]).find((j) => j === body.job);
  if (!job) return NextResponse.json({ error: "Unknown job" }, { status: 400 });
  const result = await scheduler().runNow(job);
  const state = readState(notificationsDir()).jobs[job];
  return NextResponse.json({ ...result, state });
}
