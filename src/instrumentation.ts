export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { ensureInitialized, dataDir, serverConfig, secrets } = await import("@/lib/install/runtime");
    ensureInitialized();
    const cfg = serverConfig();
    const s = secrets();
    // Configuration summary for the log. Never prints credentials, only whether they are set.
    console.log("[notflix] Data directory:", dataDir());
    console.log(`[notflix] Setup complete: ${cfg.setup.completed} · LAN access: ${cfg.server.allowLan} · reverse proxy: ${cfg.server.reverseProxy}`);
    console.log(`[notflix] TMDB: ${s.tmdbApiKey ? "configured" : "not set"} · Real-Debrid: ${s.realDebridToken ? "configured" : "not set"}`);
  } catch (err) {
    console.error("[notflix] Startup initialization failed:", err);
  }
}
