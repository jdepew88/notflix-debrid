using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Notflix.MediaEngine;
using Notflix.MediaEngine.Api;
using Notflix.MediaEngine.Media;
using Notflix.MediaEngine.Monitoring;
using Notflix.MediaEngine.Playback;
using Notflix.MediaEngine.Processes;
using Notflix.MediaEngine.Security;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
});
builder.Host.UseWindowsService(o => o.ServiceName = "NotflixMediaEngine");

var options = new EngineOptions();
builder.Configuration.GetSection("Engine").Bind(options);
try
{
    EngineConfig.Load(options, EngineConfig.DataDirFromArgs(args), Environment.GetEnvironmentVariable);
    Directory.CreateDirectory(options.CacheDirectory);
    Directory.CreateDirectory(options.TempDirectory);
}
catch (Exception ex) when (ex is EngineConfigException or IOException or UnauthorizedAccessException)
{
    Console.Error.WriteLine($"[media-engine] {ex.Message}");
    return 1;
}

builder.WebHost.ConfigureKestrel(k =>
{
    k.Listen(IPAddress.Parse(options.BindAddress), options.Port);
    k.AddServerHeader = false;
    k.Limits.MaxRequestBodySize = 1024 * 1024;
});

var binaries = FfmpegLocator.Locate(options);
var secretBytes = Encoding.UTF8.GetBytes(options.Secret);
builder.Services.AddSingleton(options);
builder.Services.AddSingleton(binaries);
builder.Services.AddSingleton(new TicketValidator(secretBytes));
builder.Services.AddSingleton(sp => new SourceGuard(sp.GetRequiredService<EngineOptions>()));
builder.Services.AddSingleton<MediaProber>();
builder.Services.AddSingleton<IProcessRunner, SystemProcessRunner>();
builder.Services.AddSingleton<IHostPlatform, SystemHostPlatform>();
builder.Services.AddSingleton<HardwareProbe>();
builder.Services.AddSingleton<HardwareCapabilitiesProvider>();
builder.Services.AddSingleton<SystemMonitor>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<SystemMonitor>());
builder.Services.AddSingleton<SessionManager>();
builder.Services.AddSingleton<ICacheSessions>(sp => sp.GetRequiredService<SessionManager>());
builder.Services.AddSingleton<CacheJanitor>();
builder.Services.AddHostedService<CacheJanitorService>();
builder.Services.AddHostedService<SessionReaper>();
builder.Services.AddSingleton<DirectStreamer>();
builder.Services.AddHttpClient(DirectStreamer.ClientName)
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        AllowAutoRedirect = true,
        MaxAutomaticRedirections = 3,
        AutomaticDecompression = DecompressionMethods.None,
        ConnectTimeout = TimeSpan.FromSeconds(10),
        PooledConnectionIdleTimeout = TimeSpan.FromSeconds(60),
    })
    .ConfigureHttpClient(c => c.Timeout = Timeout.InfiniteTimeSpan);

var app = builder.Build();
var log = app.Logger;
log.LogInformation("Notflix media engine {Version} listening on http://{Bind}:{Port} (ffmpeg: {Ffmpeg}{Missing}; cache: {Cache}, limit {Limit:0.0} GiB)",
    EngineOptions.Version, options.BindAddress, options.Port, binaries.Ffmpeg, binaries.Found ? "" : " — NOT FOUND",
    options.TempDirectory, options.CacheMaxBytes / 1073741824.0);
// The launcher stops the engine by creating <data>/run/engine.stop: a normal host shutdown, so active
// FFmpeg jobs are ended and their temporary files removed (scripts/notflix.ps1 stop).
if (options.DataDirectory is { } engineData)
{
    var stopFile = Path.Combine(engineData, "run", "engine.stop");
    try { File.Delete(stopFile); } catch (IOException) { }
    _ = Task.Run(async () =>
    {
        while (!app.Lifetime.ApplicationStopping.IsCancellationRequested)
        {
            try { await Task.Delay(500, app.Lifetime.ApplicationStopping); } catch (OperationCanceledException) { break; }
            if (!File.Exists(stopFile)) continue;
            log.LogInformation("Stop requested by the launcher");
            try { File.Delete(stopFile); } catch (IOException) { }
            app.Lifetime.StopApplication();
            break;
        }
    });
}
// Start hardware detection immediately so the first playback does not pay for it.
_ = app.Services.GetRequiredService<HardwareCapabilitiesProvider>().GetAsync();

// --- Authentication -------------------------------------------------------------------------
// Every route except /health requires the service key Next.js holds. Session routes additionally
// require the per-session token and the owner the session was created for.
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path.Equals("/health", StringComparison.OrdinalIgnoreCase))
    {
        await next();
        return;
    }
    var key = ctx.Request.Headers["X-Engine-Key"].ToString();
    var provided = Encoding.UTF8.GetBytes(key);
    if (provided.Length != secretBytes.Length || !CryptographicOperations.FixedTimeEquals(provided, secretBytes))
    {
        ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await ctx.Response.WriteAsJsonAsync(new { error = "unauthorized" });
        return;
    }
    ctx.Response.Headers.CacheControl = "no-store";
    ctx.Response.Headers["X-Accel-Buffering"] = "no";
    await next();
});

PlaybackSession? Authorize(HttpContext ctx, SessionManager sessions, string id)
{
    var s = sessions.Get(id);
    if (s is null) return null;
    var token = ctx.Request.Headers["X-Session-Token"].ToString();
    var owner = ctx.Request.Headers["X-Owner"].ToString();
    if (!sessions.TokenMatches(s, token) || owner != s.Owner) return null;
    s.Touch();
    return s;
}

IResult SessionNotFound() => Results.Json(new { error = "Playback session not found or expired.", code = "session-gone" }, statusCode: 404);

IResult ErrorResult(Exception ex) => ex switch
{
    TicketException t => Results.Json(new { error = "Playback ticket rejected.", code = "ticket", detail = t.Message }, statusCode: 403),
    SourceRejectedException s => Results.Json(new { error = "That source is not allowed.", code = "source-rejected", detail = s.Message }, statusCode: 403),
    ProbeFailedException p => Results.Json(new { error = p.Message, code = "probe-" + p.Classification }, statusCode: p.Classification is "not-found" or "forbidden" ? 410 : 502),
    EngineBusyException b => Results.Json(new { error = b.Message, code = "busy" }, statusCode: 503),
    FfmpegMissingException m => Results.Json(new { error = m.Message, code = "ffmpeg-missing" }, statusCode: 503),
    PipelineFailedException f => Results.Json(new { error = f.Message, code = "pipeline-" + f.Classification, detail = MediaProber.Redact(f.Detail) }, statusCode: 502),
    _ => Results.Json(new { error = "The media engine hit an unexpected error.", code = "internal", detail = ex.Message }, statusCode: 500),
};

// --- Routes -----------------------------------------------------------------------------------
app.MapGet("/health", () => Results.Json(new { status = "ok", service = "notflix-media-engine", version = EngineOptions.Version }));

app.MapGet("/capabilities", async (HardwareCapabilitiesProvider hw, SessionManager sessions, SystemMonitor monitor, CacheJanitor janitor, bool? refresh) =>
{
    var caps = refresh == true ? await hw.RefreshAsync() : await hw.GetAsync();
    return Results.Json(Views.Capabilities(caps, options, sessions, monitor, janitor.LastUsedBytes ?? CacheJanitor.DirectorySize(options.TempDirectory)));
});

app.MapPost("/config", async (HttpContext ctx, HardwareCapabilitiesProvider hw) =>
{
    // Settings that are safe to change without a restart (pushed by the web app when settings are saved;
    // the web app persists engine.json itself).
    RuntimeConfigRequest req;
    try
    {
        var body = await System.Text.Json.Nodes.JsonNode.ParseAsync(ctx.Request.Body, cancellationToken: ctx.RequestAborted);
        req = RuntimeConfigRequest.Parse(body as System.Text.Json.Nodes.JsonObject ?? throw new ArgumentException("Body must be a JSON object."));
    }
    catch (Exception ex) when (ex is ArgumentException or System.Text.Json.JsonException)
    {
        return Results.Json(new { error = ex.Message, code = "invalid-config" }, statusCode: 400);
    }
    if (req.MaxConcurrentVideoTranscodes is >= 1 and <= 16) options.MaxConcurrentVideoTranscodes = req.MaxConcurrentVideoTranscodes.Value;
    if (req.MaxTranscodeHeight is >= 360 and <= 4320) options.MaxTranscodeHeight = req.MaxTranscodeHeight.Value;
    if (req.MaxAheadSeconds is >= 30 and <= 1800) options.MaxAheadSeconds = req.MaxAheadSeconds.Value;
    if (req.CacheMaxBytes is { } cacheMax) options.CacheMaxBytes = cacheMax;
    // Device options are part of what detection verifies (e.g. NVENC -gpu N), so a device change re-probes.
    var reprobe = false;
    if (req.HardwareAcceleration is { } accel && accel != options.HardwareAcceleration)
    {
        reprobe = options.HardwareDevice is not null;
        options.HardwareAcceleration = accel;
    }
    if (req.HardwareDeviceSpecified && req.HardwareDevice != options.HardwareDevice)
    {
        options.HardwareDevice = req.HardwareDevice;
        reprobe = true;
    }
    var caps = reprobe ? await hw.RefreshAsync() : await hw.GetAsync();
    var selection = BackendSelector.Select(caps, options.HardwareAcceleration, options.HardwareDevice);
    log.LogInformation("Runtime config: hardware {Requested} → {Effective}{Reason}", selection.Requested, selection.Effective,
        selection.FallbackReason is null ? "" : $" ({selection.FallbackReason})");
    return Results.Json(new
    {
        options.MaxConcurrentVideoTranscodes, options.MaxTranscodeHeight, options.HardwareAcceleration, options.MaxAheadSeconds,
        options.HardwareDevice, options.CacheMaxBytes,
        selection = Views.Selection(selection),
    });
});

app.MapPost("/sessions", async (CreateSessionRequest req, TicketValidator tickets, SessionManager sessions, HttpContext ctx) =>
{
    try
    {
        var ticket = tickets.Validate(req.Ticket);
        var session = await sessions.CreateAsync(ticket, req.Client ?? ClientCapabilities.Conservative,
            req.Preferences ?? new PlaybackPreferences(), req.AudioIndex, req.SubtitleIndex, Math.Max(0, req.StartSeconds), ctx.RequestAborted);
        return Results.Json(Views.Session(session, includeToken: true), statusCode: 201);
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        log.LogWarning("Create session failed: {Type}: {Message}", ex.GetType().Name, MediaProber.Redact(ex.Message));
        return ErrorResult(ex);
    }
});

// Probe-only (source selector): verified container/codecs/languages without starting a stream.
app.MapPost("/probe", async (ProbeRequest req, TicketValidator tickets, SourceGuard guard, MediaProber prober, SessionManager sessions, HttpContext ctx) =>
{
    try
    {
        await sessions.EnsureFfmpegAsync();
        var ticket = tickets.Validate(req.Ticket);
        string input;
        bool remote;
        if (ticket.Source.Kind == "file") { input = guard.ValidateFile(ticket.Source.Path); remote = false; }
        else { input = (await guard.ValidateUrlAsync(ticket.Source.Url)).AbsoluteUri; remote = true; }
        var sw = Stopwatch.StartNew();
        var probe = await prober.ProbeAsync(input, remote, ctx.RequestAborted);
        return Results.Json(new
        {
            probeMs = sw.ElapsedMilliseconds,
            source = Views.SourceView(probe, ticket.Source, remote ? Path.GetFileName(new Uri(input).AbsolutePath) : Path.GetFileName(input)),
        });
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        return ErrorResult(ex);
    }
});

app.MapGet("/sessions/{id}", (string id, HttpContext ctx, SessionManager sessions) =>
    Authorize(ctx, sessions, id) is { } s ? Results.Json(Views.Session(s)) : SessionNotFound());

app.MapGet("/sessions/{id}/status", async (string id, double? position, HttpContext ctx, SessionManager sessions) =>
{
    if (Authorize(ctx, sessions, id) is not { } s) return SessionNotFound();
    if (position is { } pos && pos >= 0)
    {
        s.LastViewerPosition = pos;
        s.Job?.ReportViewerPosition(pos - s.GenerationStart);
    }
    await sessions.RecoverIfNeededAsync(s, ctx.RequestAborted);
    return Results.Json(Views.Status(s));
});

app.MapGet("/sessions/{id}/metrics", async (string id, HttpContext ctx, SessionManager sessions, SystemMonitor monitor, HardwareCapabilitiesProvider hw) =>
{
    if (Authorize(ctx, sessions, id) is not { } s) return SessionNotFound();
    return Results.Json(Views.Metrics(s, monitor, await hw.GetAsync()));
});

app.MapGet("/sessions/{id}/manifest", async (string id, int? generation, HttpContext ctx, SessionManager sessions) =>
{
    if (Authorize(ctx, sessions, id) is not { } s) return SessionNotFound();
    if (s.IsDirect) return Results.Json(new { error = "Session is direct play; use /stream." }, statusCode: 409);
    var job = s.Job;
    if (job is null) return Results.Json(new { error = "No active stream.", code = "no-job" }, statusCode: 409);
    if (generation is { } g && g != job.Generation)
        return Results.Json(new { error = "Stream restarted.", code = "generation-changed", generation = job.Generation }, statusCode: 410);

    if (!await job.WaitForFirstSegmentAsync(TimeSpan.FromSeconds(30), ctx.RequestAborted))
    {
        return job.State == JobState.Failed
            ? Results.Json(new { error = job.Error, code = "pipeline-" + job.ErrorClass }, statusCode: 502)
            : Results.Json(new { error = "Stream is still starting.", code = "starting" }, statusCode: 503);
    }

    // Give the player some runway on its first load: wait briefly for a second segment.
    if (job.Segments.Count < 2 && !job.Ended)
        await job.WaitForSegmentAsync(job.Segments.Count > 0 ? job.Segments[0].Index + 1 : 1, TimeSpan.FromSeconds(2.5), ctx.RequestAborted);

    var segments = job.Segments;
    var sb = new StringBuilder();
    sb.Append("#EXTM3U\n#EXT-X-VERSION:7\n");
    // HLS.js re-reads a growing playlist once per target duration. Stream-copied video makes
    // ~10 s segments (source keyframe interval), which would let the player run into the end of
    // its stale playlist and stall, so advertise the configured segment length while growing.
    var target = job.Ended && segments.Count > 0 ? (int)Math.Ceiling(segments.Max(x => x.Duration)) : options.SegmentSeconds;
    sb.Append($"#EXT-X-TARGETDURATION:{Math.Max(target, options.SegmentSeconds)}\n");
    sb.Append("#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-INDEPENDENT-SEGMENTS\n");
    sb.Append($"#EXT-X-MAP:URI=\"segments/{job.Generation}/{FfmpegArgsBuilder.InitName}\"\n");
    foreach (var seg in segments)
        sb.Append(FormattableString.Invariant($"#EXTINF:{seg.Duration:0.000000},\nsegments/{job.Generation}/{seg.Name}\n"));
    if (job.Ended) sb.Append("#EXT-X-ENDLIST\n");
    ctx.Response.Headers["X-Generation"] = job.Generation.ToString();
    ctx.Response.Headers["X-Generation-Start"] = s.GenerationStart.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
    return Results.Text(sb.ToString(), "application/vnd.apple.mpegurl");
});

var segmentName = new Regex(@"^(init\.mp4|seg_(\d{5})\.m4s)$", RegexOptions.Compiled);
app.MapGet("/sessions/{id}/segments/{generation:int}/{file}", async (string id, int generation, string file, HttpContext ctx, SessionManager sessions) =>
{
    var sw = Stopwatch.StartNew();
    if (Authorize(ctx, sessions, id) is not { } s) return SessionNotFound();
    var match = segmentName.Match(file);
    if (!match.Success) return Results.NotFound();
    var job = s.Job;
    if (job is null || job.Generation != generation)
        return Results.Json(new { error = "Stream restarted.", code = "generation-changed", generation = s.Generation }, statusCode: 410);

    if (match.Groups[2].Success)
    {
        var index = int.Parse(match.Groups[2].Value);
        if (index < job.EvictedBefore)
            return Results.Json(new { error = "Segment evicted.", code = "evicted" }, statusCode: 410);
        job.ReportSegmentRequested(index);
        if (!await job.WaitForSegmentAsync(index, TimeSpan.FromSeconds(25), ctx.RequestAborted))
            return Results.Json(new { error = "Segment not available yet.", code = "segment-timeout" }, statusCode: 503);
    }
    var path = Path.Combine(job.Directory, file);
    if (!File.Exists(path)) return Results.NotFound();
    s.RecordSegment(sw.ElapsedMilliseconds);
    // Open with share-delete so eviction never blocks on an in-flight response.
    var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, useAsync: true);
    return Results.Stream(stream, "video/mp4");
});

app.MapGet("/sessions/{id}/stream", async (string id, HttpContext ctx, SessionManager sessions, DirectStreamer streamer) =>
{
    if (Authorize(ctx, sessions, id) is not { } s)
    {
        ctx.Response.StatusCode = 404;
        return;
    }
    if (!s.IsDirect)
    {
        ctx.Response.StatusCode = 409;
        await ctx.Response.WriteAsJsonAsync(new { error = "Session is not direct play." });
        return;
    }
    await streamer.StreamAsync(ctx, s);
});

app.MapGet("/sessions/{id}/subtitles/{streamIndex:int}", async (string id, int streamIndex, double? from, HttpContext ctx, SessionManager sessions) =>
{
    if (Authorize(ctx, sessions, id) is not { } s) return SessionNotFound();
    try
    {
        var extraction = await sessions.EnsureSubtitleAsync(s, streamIndex, Math.Max(0, from ?? 0));
        string text;
        try
        {
            await using var fs = new FileStream(extraction.FilePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(fs);
            text = await reader.ReadToEndAsync();
        }
        catch (FileNotFoundException) { text = "WEBVTT\n\n"; }
        ctx.Response.Headers["X-Subtitle-Complete"] = extraction.Completed ? "1" : "0";
        ctx.Response.Headers["X-Subtitle-Failed"] = extraction.Failed ? "1" : "0";
        ctx.Response.Headers["X-Source-Start-Time"] = s.Probe.StartTime.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return Results.Text(text, "text/vtt; charset=utf-8");
    }
    catch (KeyNotFoundException) { return Results.NotFound(); }
    catch (InvalidOperationException ex) { return Results.Json(new { error = ex.Message }, statusCode: 409); }
});

app.MapPost("/sessions/{id}/seek", async (string id, SeekRequest req, HttpContext ctx, SessionManager sessions) =>
{
    if (Authorize(ctx, sessions, id) is not { } s) return SessionNotFound();
    try
    {
        var native = await sessions.SeekAsync(s, Math.Max(0, req.Position), ctx.RequestAborted, req.Force);
        return Results.Json(new { native, session = Views.Session(s) });
    }
    catch (Exception ex) when (ex is not OperationCanceledException) { return ErrorResult(ex); }
});

app.MapPost("/sessions/{id}/tracks", async (string id, TracksRequest req, HttpContext ctx, SessionManager sessions) =>
{
    if (Authorize(ctx, sessions, id) is not { } s) return SessionNotFound();
    try
    {
        await sessions.ChangeTracksAsync(s, req.AudioIndex, req.SubtitleIndex, Math.Max(0, req.Position), ctx.RequestAborted);
        return Results.Json(Views.Session(s));
    }
    catch (Exception ex) when (ex is not OperationCanceledException) { return ErrorResult(ex); }
});

app.MapDelete("/sessions/{id}", async (string id, HttpContext ctx, SessionManager sessions) =>
{
    if (Authorize(ctx, sessions, id) is null) return Results.NoContent();
    await sessions.DestroyAsync(id);
    return Results.NoContent();
});

app.MapGet("/sessions", (SessionManager sessions) => Results.Json(sessions.All.Select(s => new
{
    id = s.Id,
    mode = s.Decision.ModeLabel,
    provider = s.Source.Provider,
    state = s.Job?.State.ToString() ?? (s.IsDirect ? "Direct" : "Idle"),
    createdAt = s.CreatedAt,
    lastAccess = s.LastAccess,
    pipeline = s.Job?.Attempt?.Label,
})));

await app.RunAsync();
return 0;
