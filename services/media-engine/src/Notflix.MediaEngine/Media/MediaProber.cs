using Notflix.MediaEngine.Processes;

namespace Notflix.MediaEngine.Media;

public sealed class ProbeFailedException(string message, string classification) : Exception(message)
{
    /// <summary>"timeout", "unreachable", "unsupported", "not-found".</summary>
    public string Classification { get; } = classification;
}

public sealed class MediaProber(FfmpegBinaries binaries, EngineOptions options, ILogger<MediaProber> logger)
{
    public const string UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Notflix-MediaEngine/1.0";

    // A probe-only request (source selector) followed by a session for the same file costs one ffprobe.
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(20);
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, (DateTimeOffset At, Task<MediaProbe> Probe)> _cache = new();

    public Task<MediaProbe> ProbeAsync(string input, bool isRemote, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        if (_cache.TryGetValue(input, out var hit) && now - hit.At < CacheTtl && !hit.Probe.IsFaulted) return hit.Probe.WaitAsync(ct);
        if (_cache.Count > 500)
            foreach (var (k, v) in _cache) if (now - v.At > CacheTtl) _cache.TryRemove(k, out _);
        var task = ProbeUncachedAsync(input, isRemote, CancellationToken.None);
        _cache[input] = (now, task);
        _ = task.ContinueWith(failed => _cache.TryRemove(input, out _), TaskContinuationOptions.OnlyOnFaulted);
        return task.WaitAsync(ct);
    }

    private async Task<MediaProbe> ProbeUncachedAsync(string input, bool isRemote, CancellationToken ct)
    {
        var args = new List<string> { "-v", "error", "-hide_banner" };
        if (isRemote)
        {
            args.AddRange(["-rw_timeout", "15000000", "-user_agent", UserAgent]);
        }
        // Bounded probing: enough to see every stream in MKV/MP4 headers without reading far into the file.
        args.AddRange([
            // Container headers (MKV/MP4) carry stream parameters; long analysis only slows startup.
            "-probesize", "6000000",
            "-analyzeduration", "3000000",
            "-print_format", "json",
            "-show_format", "-show_streams",
            "-i", input,
        ]);

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var result = await ProcessRunner.RunAsync(binaries.Ffprobe, args, TimeSpan.FromSeconds(options.ProbeTimeoutSeconds), ct);
        if (result.TimedOut)
            throw new ProbeFailedException("The source did not respond in time.", "timeout");
        if (result.ExitCode != 0 || string.IsNullOrWhiteSpace(result.StdOut))
        {
            var err = result.StdErr.Trim();
            logger.LogWarning("ffprobe failed ({Exit}) after {Ms} ms: {Error}", result.ExitCode, sw.ElapsedMilliseconds, Redact(err));
            var cls = Classify(err);
            throw new ProbeFailedException(cls switch
            {
                "not-found" => "The source file is no longer available (link expired or removed).",
                "forbidden" => "The source refused access (link expired or not authorized).",
                "unreachable" => "The source server could not be reached.",
                _ => "The source could not be read as a media file.",
            }, cls);
        }

        var probe = MediaProbe.Parse(result.StdOut);
        logger.LogInformation("Probed {Container} in {Ms} ms: video={Video} audio={Audio} subs={Subs}",
            probe.Container, sw.ElapsedMilliseconds, probe.Video?.Codec ?? "none", probe.Audio.Count, probe.Subtitles.Count);
        return probe;
    }

    public static string Classify(string stderr)
    {
        var e = stderr.ToLowerInvariant();
        if (e.Contains("404") || e.Contains("no such file")) return "not-found";
        if (e.Contains("403") || e.Contains("401")) return "forbidden";
        if (e.Contains("connection refused") || e.Contains("timed out") || e.Contains("resolve") || e.Contains("network"))
            return "unreachable";
        return "unsupported";
    }

    /// <summary>Strips URLs (signed links, tokens) from diagnostic text.</summary>
    public static string Redact(string text) =>
        System.Text.RegularExpressions.Regex.Replace(text, @"https?://[^\s'""]+", m =>
        {
            if (!Uri.TryCreate(m.Value, UriKind.Absolute, out var uri)) return "[url]";
            return $"{uri.Scheme}://{uri.Host}/…/{Path.GetFileName(uri.AbsolutePath)}";
        });
}
