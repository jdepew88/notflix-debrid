using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Notflix.MediaEngine.Media;
using Notflix.MediaEngine.Monitoring;
using Notflix.MediaEngine.Security;

namespace Notflix.MediaEngine.Playback;

public sealed class EngineBusyException(string message) : Exception(message);

/// <summary>FFmpeg/ffprobe is not installed or not runnable; playback beyond nothing is impossible.</summary>
public sealed class FfmpegMissingException(string message) : Exception(message);

public sealed class SessionManager(
    EngineOptions options,
    FfmpegBinaries binaries,
    MediaProber prober,
    HardwareCapabilitiesProvider hardware,
    SourceGuard guard,
    SystemMonitor monitor,
    ILogger<SessionManager> logger) : ICacheSessions
{
    private readonly ConcurrentDictionary<string, PlaybackSession> _sessions = new();
    private readonly object _slots = new();
    private int _jobs;
    private int _videoJobs;

    public IReadOnlyCollection<PlaybackSession> All => _sessions.Values.ToList();
    public int ActiveJobs => Volatile.Read(ref _jobs);
    public int ActiveVideoTranscodes => Volatile.Read(ref _videoJobs);

    public PlaybackSession? Get(string id) => _sessions.TryGetValue(id, out var s) ? s : null;

    public bool TokenMatches(PlaybackSession session, string? token)
    {
        if (string.IsNullOrEmpty(token)) return false;
        var a = Encoding.UTF8.GetBytes(session.Token);
        var b = Encoding.UTF8.GetBytes(token);
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }

    public async Task<PlaybackSession> CreateAsync(
        TicketPayload ticket,
        ClientCapabilities client,
        PlaybackPreferences prefs,
        int? audioIndex,
        int? subtitleIndex,
        double startSeconds,
        CancellationToken ct)
    {
        var created = Stopwatch.StartNew();
        await EnsureFfmpegAsync();
        string input;
        bool remote;
        if (ticket.Source.Kind == "file")
        {
            input = guard.ValidateFile(ticket.Source.Path);
            remote = false;
        }
        else
        {
            input = (await guard.ValidateUrlAsync(ticket.Source.Url)).AbsoluteUri;
            remote = true;
        }

        var hwTask = hardware.GetAsync();
        var probeWatch = Stopwatch.StartNew();
        var probe = await prober.ProbeAsync(input, remote, ct);
        var probeMs = probeWatch.ElapsedMilliseconds;
        if (probe.Video is null) throw new ProbeFailedException("The file has no video stream.", "unsupported");
        var hw = await hwTask;

        var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant();
        var session = new PlaybackSession
        {
            Id = id,
            Token = TicketValidator.Base64Url(RandomNumberGenerator.GetBytes(32)),
            Owner = ticket.Owner,
            Source = ticket.Source,
            Input = input,
            IsRemote = remote,
            Probe = probe,
            WorkDirectory = Path.Combine(options.TempDirectory, id),
            Client = client,
            Prefs = prefs,
            SubtitleIndex = subtitleIndex,
            ProbeMs = probeMs,
        };
        session.Decision = PlaybackDecider.Decide(probe, client, prefs, hw, options, audioIndex, subtitleIndex);
        session.AddEvent("decision", $"{session.Decision.ModeLabel}: {string.Join("; ", session.Decision.Reasons)}");
        _sessions[id] = session;
        logger.LogInformation("Session {Id} ({Provider}) → {Mode} [{Reasons}] probe {ProbeMs} ms",
            id, ticket.Source.Provider, session.Decision.ModeLabel, string.Join("; ", session.Decision.Reasons), probeMs);

        try
        {
            if (session.IsDirect)
            {
                session.StartupMs = created.ElapsedMilliseconds;
            }
            else
            {
                await StartGenerationAsync(session, startSeconds, ct);
                session.StartupMs = created.ElapsedMilliseconds;
            }
        }
        catch
        {
            await DestroyAsync(id);
            throw;
        }
        return session;
    }

    /// <summary>
    /// Starts a new HLS generation at <paramref name="startSeconds"/> (movie time), walking the
    /// fallback ladder (NVDEC+NVENC → CPU decode+NVENC → x264) when a rung fails before output.
    /// </summary>
    public async Task StartGenerationAsync(PlaybackSession session, double startSeconds, CancellationToken ct)
    {
        await StopJobAsync(session);
        var decision = session.Decision;
        var isVideo = decision.Video == StreamAction.Transcode;
        var lastError = "";
        var fastProbe = true;

        while (true)
        {
            var attempt = isVideo ? decision.Attempts[Math.Min(session.AttemptIndex, decision.Attempts.Count - 1)] : null;
            if (!TryReserve(isVideo))
                throw new EngineBusyException(isVideo
                    ? $"All {options.MaxConcurrentVideoTranscodes} conversion slots are busy. Try again shortly."
                    : "The media engine is at capacity. Try again shortly.");

            var generation = ++session.Generation;
            var dir = Path.Combine(session.WorkDirectory, $"g{generation}");
            var spec = new HlsJobSpec(session.Input, session.IsRemote, session.Probe, decision, attempt,
                Math.Max(0, startSeconds), dir, options.SegmentSeconds, fastProbe);
            var job = new TranscodeJob(generation, spec, attempt, binaries, options, monitor, logger);
            session.Job = job;
            try
            {
                job.Start();
            }
            catch (Exception ex)
            {
                Release(isVideo);
                session.Job = null;
                throw new PipelineFailedException("The media engine could not start FFmpeg.", "unknown", ex.Message);
            }
            _ = job.Exited.ContinueWith(_ => Release(isVideo), TaskScheduler.Default);

            var ok = await job.WaitForFirstSegmentAsync(TimeSpan.FromSeconds(isVideo ? 45 : 35), ct);
            if (ok)
            {
                session.AddEvent("generation", $"g{generation} started at {startSeconds:0.0}s via {attempt?.Label ?? decision.ModeLabel}");
                return;
            }

            lastError = job.Error ?? "timed out waiting for the first segment";
            var cls = job.ErrorClass ?? "timeout";
            session.AddEvent("error", $"g{generation} {attempt?.Label ?? decision.ModeLabel} failed: {lastError} ({cls})");
            await job.DisposeAsync();
            session.Job = null;

            // First retry the same rung with full stream analysis (some files need it to find parameters).
            if (fastProbe && cls != "source")
            {
                fastProbe = false;
                logger.LogInformation("Session {Id}: retrying {Attempt} with full stream analysis", session.Id, attempt?.Label ?? decision.ModeLabel);
                continue;
            }
            fastProbe = true;

            // Source failures will not be fixed by a different encoder; don't burn the ladder on them.
            var canFallBack = isVideo && cls != "source" && session.AttemptIndex < decision.Attempts.Count - 1;
            if (!canFallBack)
                throw new PipelineFailedException(cls == "source"
                    ? "The source stopped responding while starting playback."
                    : "This file could not be converted for playback.", cls, lastError);
            session.AttemptIndex++;
            logger.LogWarning("Session {Id}: falling back to {Next}", session.Id, decision.Attempts[session.AttemptIndex].Label);
        }
    }

    /// <summary>
    /// Seek in movie time. Returns true when the position is (or soon will be) inside the current
    /// generation so the player can seek natively; otherwise a new generation is started there.
    /// </summary>
    public async Task<bool> SeekAsync(PlaybackSession session, double position, CancellationToken ct, bool force = false)
    {
        if (session.IsDirect) return true;
        await session.Lock.WaitAsync(ct);
        try
        {
            var job = session.Job;
            if (!force && job is not null && job.State is not (JobState.Failed or JobState.Cancelled))
            {
                var genStart = session.GenerationStart;
                var segments = job.Segments;
                var evictedStart = genStart;
                if (job.EvictedBefore > 0)
                {
                    var firstKept = segments.FirstOrDefault(s => s.Index >= job.EvictedBefore);
                    evictedStart = genStart + (firstKept?.Start ?? job.ProducedDuration);
                }
                var producedEnd = genStart + job.ProducedDuration;
                // Encoders produce ~1 segment/s or faster; a short look-ahead avoids needless restarts.
                var reachable = producedEnd + (job.Ended ? 0 : 30);
                if (position >= evictedStart && position <= reachable)
                {
                    job.ReportViewerPosition(position - genStart);
                    return true;
                }
            }
            session.Restarts++;
            await StartGenerationAsync(session, position, ct);
            return false;
        }
        finally { session.Lock.Release(); }
    }

    public async Task ChangeTracksAsync(PlaybackSession session, int? audioIndex, int? subtitleIndex, double position, CancellationToken ct)
    {
        await session.Lock.WaitAsync(ct);
        try
        {
            var hw = await hardware.GetAsync();
            var previous = session.Decision;
            var next = PlaybackDecider.Decide(session.Probe, session.Client, session.Prefs, hw, options, audioIndex, subtitleIndex);
            session.SubtitleIndex = subtitleIndex;
            var sameOutput = previous.Mode == next.Mode && previous.AudioStreamIndex == next.AudioStreamIndex &&
                             previous.BurnSubtitleIndex == next.BurnSubtitleIndex;
            session.Decision = next;
            if (sameOutput) return;
            session.AttemptIndex = 0;
            session.AddEvent("tracks", $"Tracks changed → {next.ModeLabel}");
            if (next.Mode == PlaybackMode.DirectPlay) await StopJobAsync(session);
            else
            {
                session.Restarts++;
                await StartGenerationAsync(session, position, ct);
            }
        }
        finally { session.Lock.Release(); }
    }

    /// <summary>Called on status polls: restarts a generation that died mid-stream (bounded).</summary>
    public async Task RecoverIfNeededAsync(PlaybackSession session, CancellationToken ct)
    {
        var job = session.Job;
        if (job is null || job.State != JobState.Failed || session.Restarts >= 4) return;
        if (!await session.Lock.WaitAsync(0, ct)) return;
        try
        {
            if (session.Job != job) return;
            var resumeAt = session.GenerationStart + job.ProducedDuration;
            if (job.ErrorClass == "hardware" && session.AttemptIndex < session.Decision.Attempts.Count - 1)
                session.AttemptIndex++;
            session.Restarts++;
            session.AddEvent("recover", $"Restarting at {resumeAt:0.0}s after: {job.Error}");
            logger.LogWarning("Session {Id}: generation {Gen} failed mid-stream, restarting at {At:0.0}s", session.Id, job.Generation, resumeAt);
            await StartGenerationAsync(session, resumeAt, ct);
        }
        catch (Exception ex)
        {
            session.AddEvent("error", $"Recovery failed: {ex.Message}");
        }
        finally { session.Lock.Release(); }
    }

    public async Task<SubtitleExtraction> EnsureSubtitleAsync(PlaybackSession session, int streamIndex, double fromSeconds)
    {
        var sub = session.Probe.Subtitles.FirstOrDefault(s => s.Index == streamIndex)
                  ?? throw new KeyNotFoundException("subtitle stream not found");
        if (!sub.IsText) throw new InvalidOperationException("image subtitles are rendered into the video instead");

        if (session.Subtitles.TryGetValue(streamIndex, out var existing))
        {
            // Reuse when the request is within the already-extracted range.
            if (existing.StartSeconds <= fromSeconds + 1 && !existing.Failed) return existing;
            existing.Process?.Kill(true);
            session.Subtitles.TryRemove(streamIndex, out _);
        }

        Directory.CreateDirectory(session.WorkDirectory);
        var start = Math.Max(0, fromSeconds - 30);
        var file = Path.Combine(session.WorkDirectory, $"sub_{streamIndex}_{(int)start}.vtt");
        var extraction = new SubtitleExtraction { StreamIndex = streamIndex, StartSeconds = start, FilePath = file };
        var psi = new ProcessStartInfo(binaries.Ffmpeg)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true,
        };
        foreach (var a in FfmpegArgsBuilder.BuildSubtitleExtract(session.Input, session.IsRemote, streamIndex, start, file))
            psi.ArgumentList.Add(a);
        var proc = Process.Start(psi)!;
        Processes.NativeProcess.AttachToJob(proc);
        proc.ErrorDataReceived += (_, _) => { };
        proc.BeginErrorReadLine();
        proc.BeginOutputReadLine();
        extraction.Process = proc;
        session.Subtitles[streamIndex] = extraction;
        _ = proc.WaitForExitAsync().ContinueWith(_ =>
        {
            extraction.Completed = proc.ExitCode == 0;
            extraction.Failed = proc.ExitCode != 0;
        }, TaskScheduler.Default);
        await Task.Delay(300);
        return extraction;
    }

    private async Task StopJobAsync(PlaybackSession session)
    {
        if (session.Job is { } old)
        {
            session.Job = null;
            await old.DisposeAsync();
        }
    }

    private bool TryReserve(bool video)
    {
        lock (_slots)
        {
            if (_jobs >= options.MaxConcurrentJobs) return false;
            if (video && _videoJobs >= options.MaxConcurrentVideoTranscodes) return false;
            _jobs++;
            if (video) _videoJobs++;
            return true;
        }
    }

    private void Release(bool video)
    {
        lock (_slots)
        {
            _jobs = Math.Max(0, _jobs - 1);
            if (video) _videoJobs = Math.Max(0, _videoJobs - 1);
        }
    }

    public async Task<bool> DestroyAsync(string id)
    {
        if (!_sessions.TryRemove(id, out var session)) return false;
        session.Disposed = true;
        await StopJobAsync(session);
        foreach (var sub in session.Subtitles.Values)
        {
            try { if (sub.Process is { HasExited: false } p) p.Kill(true); } catch { /* exited */ }
        }
        for (var i = 0; i < 5; i++)
        {
            try
            {
                if (Directory.Exists(session.WorkDirectory)) Directory.Delete(session.WorkDirectory, true);
                break;
            }
            catch (IOException) { await Task.Delay(250); }
            catch (UnauthorizedAccessException) { await Task.Delay(250); }
        }
        logger.LogInformation("Session {Id} closed after {Min:0.0} min", id, (DateTimeOffset.UtcNow - session.CreatedAt).TotalMinutes);
        return true;
    }

    public async Task ReapAsync()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var s in _sessions.Values)
        {
            var idle = now - s.LastAccess > TimeSpan.FromSeconds(options.SessionIdleSeconds) && !s.DirectActive;
            var tooOld = now - s.CreatedAt > TimeSpan.FromHours(options.MaxSessionHours);
            if (idle || tooOld)
            {
                logger.LogInformation("Reaping session {Id} ({Why})", s.Id, idle ? "idle" : "max age");
                await DestroyAsync(s.Id);
            }
        }
    }

    public async Task ShutdownAsync()
    {
        foreach (var id in _sessions.Keys.ToList()) await DestroyAsync(id);
    }

    /// <summary>Throws <see cref="FfmpegMissingException"/> when ffmpeg/ffprobe cannot be used on this host.</summary>
    public async Task EnsureFfmpegAsync()
    {
        if (!binaries.Found || !(await hardware.GetAsync()).FfmpegAvailable)
            throw new FfmpegMissingException(
                "FFmpeg is not installed or could not be started, so this video cannot be played. Install FFmpeg (with ffprobe) " +
                "or set its location in the engine settings.");
    }

    public bool IsActiveSessionDirectory(string name) => _sessions.ContainsKey(name);

    public long EvictBehindViewer(long bytesWanted)
    {
        long freed = 0;
        // Idle viewers first: their already-watched output is the least likely to be revisited.
        foreach (var s in _sessions.Values.OrderBy(s => s.LastAccess))
        {
            if (freed >= bytesWanted) break;
            if (s.Job is { } job) freed += job.EvictBehindViewer(bytesWanted - freed);
        }
        return freed;
    }
}

public sealed class PipelineFailedException(string message, string classification, string detail) : Exception(message)
{
    public string Classification { get; } = classification;
    public string Detail { get; } = detail;
}

public sealed class SessionReaper(SessionManager manager) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken); }
            catch (OperationCanceledException) { break; }
            await manager.ReapAsync();
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await manager.ShutdownAsync();
        await base.StopAsync(cancellationToken);
    }
}
