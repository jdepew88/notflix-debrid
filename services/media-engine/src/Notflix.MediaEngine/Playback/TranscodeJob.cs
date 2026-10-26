using System.Diagnostics;
using System.Globalization;
using System.Text;
using Notflix.MediaEngine.Media;
using Notflix.MediaEngine.Monitoring;
using Notflix.MediaEngine.Processes;

namespace Notflix.MediaEngine.Playback;

public sealed record HlsSegment(int Index, string Name, double Duration, double Start);

public enum JobState { Starting, Running, Throttled, Completed, Failed, Cancelled }

public sealed record FfmpegProgress(
    long Frame = 0,
    double Fps = 0,
    double? BitrateKbps = null,
    long TotalSize = 0,
    double OutTimeSeconds = 0,
    long DupFrames = 0,
    long DropFrames = 0,
    double? Speed = null);

/// <summary>
/// One FFmpeg process producing one HLS "generation" for a session (a new generation starts on a
/// seek outside the produced window or on a track change). Owns its temp directory, parses
/// -progress output, keeps the encoder within MaxAheadSeconds of the viewer (suspend/resume)
/// and deletes segments far behind the viewer so disk usage stays bounded.
/// </summary>
public sealed class TranscodeJob : IAsyncDisposable
{
    private readonly FfmpegBinaries _bin;
    private readonly List<string> _args;
    private readonly ILogger _logger;
    private readonly EngineOptions _options;
    private readonly SystemMonitor _monitor;
    private readonly CancellationTokenSource _cts = new();
    private readonly StringBuilder _stderrTail = new();
    private readonly object _gate = new();
    private readonly TaskCompletionSource _exited = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Process? _process;
    private List<HlsSegment> _segments = [];
    private bool _ended;
    private Dictionary<uint, uint>? _timescales;
    private double _viewerPosition;
    private int _evictedBefore;
    private TimeSpan _lastCpu;
    private DateTimeOffset _lastCpuAt;
    private int _videoJobCounted;

    public TranscodeJob(int generation, HlsJobSpec spec, PipelineAttempt? attempt, FfmpegBinaries bin,
        EngineOptions options, SystemMonitor monitor, ILogger logger)
    {
        Generation = generation;
        Spec = spec;
        Attempt = attempt;
        _bin = bin;
        _options = options;
        _monitor = monitor;
        _logger = logger;
        _args = FfmpegArgsBuilder.BuildHls(spec);
        IsVideoTranscode = spec.Decision.Video == StreamAction.Transcode;
    }

    public int Generation { get; }
    public HlsJobSpec Spec { get; }
    public PipelineAttempt? Attempt { get; }
    public bool IsVideoTranscode { get; }
    public string Directory => Spec.OutputDirectory;
    public JobState State { get; private set; } = JobState.Starting;
    public string? Error { get; private set; }
    public string? ErrorClass { get; private set; }
    public DateTimeOffset StartedAt { get; private set; }
    public DateTimeOffset? FirstSegmentAt { get; private set; }
    /// <summary>Source-timeline seconds at which this generation's first segment starts.</summary>
    public double? TimelineStart { get; private set; }
    public FfmpegProgress Progress { get; private set; } = new();
    public double? ProcessCpuPercent { get; private set; }
    public double? ProcessMemoryMiB { get; private set; }
    public double PeakEncoderPercent { get; private set; }
    public double PeakDecoderPercent { get; private set; }
    public double PeakGpuPercent { get; private set; }
    public bool Ended { get { lock (_gate) return _ended; } }
    public int EvictedBefore { get { lock (_gate) return _evictedBefore; } }
    public Task Exited => _exited.Task;
    public int? ProcessId { get { try { return _process?.Id; } catch { return null; } } }
    public string StderrTail { get { lock (_gate) return _stderrTail.ToString(); } }
    public string CommandLineRedacted => string.Join(' ', _args.Select(a => a == Spec.Input ? "<source>" : a.Contains(' ') ? $"\"{a}\"" : a));

    public IReadOnlyList<HlsSegment> Segments { get { lock (_gate) return _segments; } }
    public double ProducedDuration { get { lock (_gate) return _segments.Count == 0 ? 0 : _segments[^1].Start + _segments[^1].Duration; } }

    public void Start()
    {
        System.IO.Directory.CreateDirectory(Directory);
        var psi = new ProcessStartInfo(_bin.Ffmpeg)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = Directory,
        };
        foreach (var a in _args) psi.ArgumentList.Add(a);

        StartedAt = DateTimeOffset.UtcNow;
        _process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        _process.Start();
        NativeProcess.AttachToJob(_process);
        try { _process.PriorityClass = ProcessPriorityClass.BelowNormal; } catch { /* not fatal */ }
        if (IsVideoTranscode)
        {
            _monitor.VideoJobStarted();
            Interlocked.Exchange(ref _videoJobCounted, 1);
            _monitor.GpuSampled += OnGpuSample;
        }
        State = JobState.Running;
        _logger.LogInformation("Job g{Gen} started ({Attempt}) at {Start:0.0}s: {Cmd}",
            Generation, Attempt?.Label ?? Spec.Decision.ModeLabel, Spec.StartSeconds, CommandLineRedacted);

        _ = Task.Run(ReadProgressAsync);
        _ = Task.Run(ReadStderrAsync);
        _ = Task.Run(MonitorAsync);
        _ = Task.Run(async () =>
        {
            try { await _process.WaitForExitAsync(); } catch { /* disposed */ }
            OnExited();
        });
    }

    private void OnGpuSample(GpuSample s)
    {
        if (State is not (JobState.Running or JobState.Starting)) return;
        PeakGpuPercent = Math.Max(PeakGpuPercent, s.GpuPercent ?? 0);
        PeakEncoderPercent = Math.Max(PeakEncoderPercent, s.EncoderPercent ?? 0);
        PeakDecoderPercent = Math.Max(PeakDecoderPercent, s.DecoderPercent ?? 0);
    }

    private async Task ReadProgressAsync()
    {
        var p = _process!;
        var kv = new Dictionary<string, string>();
        try
        {
            while (await p.StandardOutput.ReadLineAsync() is { } line)
            {
                var eq = line.IndexOf('=');
                if (eq <= 0) continue;
                var key = line[..eq].Trim();
                var value = line[(eq + 1)..].Trim();
                if (key == "progress")
                {
                    Progress = ParseProgress(kv);
                    kv.Clear();
                }
                else kv[key] = value;
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException) { }
    }

    public static FfmpegProgress ParseProgress(IReadOnlyDictionary<string, string> kv)
    {
        double D(string k) => kv.TryGetValue(k, out var v) && double.TryParse(v.TrimEnd('x'), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : 0;
        long L(string k) => kv.TryGetValue(k, out var v) && long.TryParse(v, out var l) ? l : 0;
        double? bitrate = null;
        if (kv.TryGetValue("bitrate", out var br) && br.EndsWith("kbits/s") &&
            double.TryParse(br.Replace("kbits/s", ""), NumberStyles.Float, CultureInfo.InvariantCulture, out var b))
            bitrate = b;
        double? speed = kv.TryGetValue("speed", out var sp) && sp != "N/A" &&
                        double.TryParse(sp.TrimEnd('x'), NumberStyles.Float, CultureInfo.InvariantCulture, out var s) ? s : null;
        var outUs = L("out_time_us");
        if (outUs == 0) outUs = L("out_time_ms"); // ffmpeg reports microseconds under both keys
        return new FfmpegProgress(L("frame"), D("fps"), bitrate, L("total_size"), outUs / 1_000_000.0,
            L("dup_frames"), L("drop_frames"), speed);
    }

    private async Task ReadStderrAsync()
    {
        try
        {
            while (await _process!.StandardError.ReadLineAsync() is { } line)
            {
                lock (_gate)
                {
                    _stderrTail.AppendLine(MediaProber.Redact(line));
                    if (_stderrTail.Length > 8000) _stderrTail.Remove(0, _stderrTail.Length - 6000);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException) { }
    }

    private async Task MonitorAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            RefreshPlaylist();
            UpdateProcessStats();
            ThrottleAndEvict();
            if (State is JobState.Completed or JobState.Failed or JobState.Cancelled) break;
            try { await Task.Delay(400, _cts.Token); } catch (OperationCanceledException) { break; }
        }
    }

    public void RefreshPlaylist()
    {
        var path = Path.Combine(Directory, FfmpegArgsBuilder.PlaylistName);
        string text;
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(fs);
            text = reader.ReadToEnd();
        }
        catch (IOException) { return; }
        catch (UnauthorizedAccessException) { return; }

        var (segments, ended) = ParsePlaylist(text);
        lock (_gate)
        {
            if (segments.Count >= _segments.Count) _segments = segments;
            _ended |= ended;
        }
        if (FirstSegmentAt is null && segments.Count > 0)
        {
            FirstSegmentAt = DateTimeOffset.UtcNow;
            _logger.LogInformation("Job g{Gen} first segment after {Ms} ms", Generation, (int)(FirstSegmentAt.Value - StartedAt).TotalMilliseconds);
        }
        // hlsenc writes init.mp4 slightly after the first segment shows up in the playlist; retry until both exist.
        if (TimelineStart is null && segments.Count > 0 && _timelineAttempts++ < 50)
        {
            TimelineStart = ReadTimelineStart(segments[0].Name);
            if (TimelineStart is { } ts)
                _logger.LogInformation("Job g{Gen} timeline starts at {Start:0.000}s", Generation, ts);
        }
    }

    private int _timelineAttempts;

    public bool InitSegmentReady => File.Exists(Path.Combine(Directory, FfmpegArgsBuilder.InitName));

    private double? ReadTimelineStart(string firstSegment)
    {
        if (!InitSegmentReady) return null;
        try
        {
            _timescales ??= Fmp4Inspector.ReadTimescales(File.ReadAllBytes(Path.Combine(Directory, FfmpegArgsBuilder.InitName)));
            var seg = File.ReadAllBytes(Path.Combine(Directory, firstSegment));
            return Fmp4Inspector.EarliestDecodeTimeSeconds(seg, _timescales);
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Could not read segment timing: {Error}", ex.Message);
            return null;
        }
    }

    private static readonly System.Text.RegularExpressions.Regex SegmentIndex = new(@"^seg_(\d+)\.m4s$");

    public static (List<HlsSegment> Segments, bool Ended) ParsePlaylist(string text)
    {
        var segments = new List<HlsSegment>();
        double pending = 0, start = 0;
        var ended = false;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith("#EXTINF:", StringComparison.Ordinal))
            {
                var value = line["#EXTINF:".Length..].Split(',')[0];
                double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out pending);
            }
            else if (line == "#EXT-X-ENDLIST") ended = true;
            else if (line.Length > 0 && !line.StartsWith('#'))
            {
                var name = Path.GetFileName(line);
                var m = SegmentIndex.Match(name);
                var index = m.Success ? int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) : segments.Count;
                segments.Add(new HlsSegment(index, name, pending, start));
                start += pending;
                pending = 0;
            }
        }
        return (segments, ended);
    }

    /// <summary>Viewer position relative to this generation's start (seconds).</summary>
    public void ReportViewerPosition(double secondsIntoGeneration)
    {
        lock (_gate) _viewerPosition = Math.Max(0, secondsIntoGeneration);
    }

    public void ReportSegmentRequested(int index)
    {
        lock (_gate)
        {
            var seg = _segments.FirstOrDefault(s => s.Index == index);
            if (seg is not null && seg.Start > _viewerPosition - 30) _viewerPosition = Math.Max(_viewerPosition, seg.Start - _options.SegmentSeconds * 2);
        }
        if (State == JobState.Throttled) Resume("segment requested");
    }

    private void ThrottleAndEvict()
    {
        if (_process is null || _process.HasExited) return;
        double ahead;
        lock (_gate) ahead = ProducedDurationUnsafe() - _viewerPosition;

        if (State == JobState.Running && ahead > _options.MaxAheadSeconds)
        {
            if (NativeProcess.Suspend(_process))
            {
                State = JobState.Throttled;
                _logger.LogDebug("Job g{Gen} throttled ({Ahead:0}s ahead)", Generation, ahead);
            }
        }
        else if (State == JobState.Throttled && ahead < _options.MaxAheadSeconds - 45)
        {
            Resume("viewer caught up");
        }

        // Evict segments far behind the viewer. They stay listed; the player restarts a generation
        // instead of seeking natively into evicted time (it reads evictedBefore from status).
        List<HlsSegment> toDelete = [];
        lock (_gate)
        {
            foreach (var s in _segments)
            {
                if (s.Index < _evictedBefore) continue;
                if (s.Start + s.Duration < _viewerPosition - _options.BackBufferSeconds) toDelete.Add(s);
                else break;
            }
            if (toDelete.Count > 0) _evictedBefore = toDelete[^1].Index + 1;
        }
        foreach (var s in toDelete)
        {
            try { File.Delete(Path.Combine(Directory, s.Name)); } catch { /* retried next pass */ }
        }
    }

    private double ProducedDurationUnsafe() => _segments.Count == 0 ? 0 : _segments[^1].Start + _segments[^1].Duration;

    private void Resume(string why)
    {
        if (_process is null || _process.HasExited) return;
        if (NativeProcess.Resume(_process))
        {
            State = JobState.Running;
            _logger.LogDebug("Job g{Gen} resumed: {Why}", Generation, why);
        }
    }

    private void UpdateProcessStats()
    {
        try
        {
            if (_process is null || _process.HasExited) return;
            _process.Refresh();
            var now = DateTimeOffset.UtcNow;
            var cpu = _process.TotalProcessorTime;
            if (_lastCpuAt != default)
            {
                var wall = (now - _lastCpuAt).TotalMilliseconds;
                if (wall > 0)
                    ProcessCpuPercent = Math.Round(100.0 * (cpu - _lastCpu).TotalMilliseconds / (wall * Environment.ProcessorCount), 1);
            }
            _lastCpu = cpu;
            _lastCpuAt = now;
            ProcessMemoryMiB = Math.Round(_process.WorkingSet64 / 1048576.0, 1);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception) { }
    }

    /// <summary>
    /// Deletes the oldest already-watched segments (ending more than <paramref name="keepBehindSeconds"/>
    /// behind the viewer) until about <paramref name="bytesWanted"/> are freed. Never touches the newest
    /// listed segment, the init segment, the playlist or the segment FFmpeg is writing (a .tmp file that
    /// is not listed yet). Evicted segments stay listed; the player restarts a generation to revisit them.
    /// </summary>
    public long EvictBehindViewer(long bytesWanted, double keepBehindSeconds = 30)
    {
        List<HlsSegment> candidates = [];
        lock (_gate)
        {
            if (_segments.Count < 2) return 0;
            var newest = _segments[^1].Index;
            foreach (var seg in _segments)
            {
                if (seg.Index < _evictedBefore) continue;
                if (seg.Index >= newest || seg.Start + seg.Duration >= _viewerPosition - keepBehindSeconds) break;
                candidates.Add(seg);
            }
        }
        long freed = 0;
        var lastEvicted = -1;
        foreach (var seg in candidates)
        {
            if (freed >= bytesWanted) break;
            var path = Path.Combine(Directory, seg.Name);
            try
            {
                var size = File.Exists(path) ? new FileInfo(path).Length : 0;
                File.Delete(path);
                freed += size;
                lastEvicted = seg.Index;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { break; }
        }
        if (lastEvicted >= 0)
            lock (_gate) _evictedBefore = Math.Max(_evictedBefore, lastEvicted + 1);
        return freed;
    }

    private void OnExited()
    {
        int code;
        try { code = _process!.ExitCode; } catch { code = -1; }
        if (_process is not null) NativeProcess.Forget(_process);
        RefreshPlaylist();
        if (_cts.IsCancellationRequested) State = JobState.Cancelled;
        else if (code == 0) { State = JobState.Completed; lock (_gate) _ended = true; }
        else
        {
            State = JobState.Failed;
            var tail = StderrTail;
            ErrorClass = ClassifyFailure(tail);
            Error = ErrorClass switch
            {
                "source" => "The source stopped responding.",
                "hardware" => "Hardware video processing failed.",
                "decode" => "The source contains data the decoder could not read.",
                _ => "Media processing stopped unexpectedly.",
            };
            _logger.LogWarning("Job g{Gen} failed (exit {Code}, {Class}): {Tail}", Generation, code, ErrorClass,
                tail.Length > 1200 ? tail[^1200..] : tail);
        }
        StopVideoCounting();
        _exited.TrySetResult();
    }

    private void StopVideoCounting()
    {
        if (Interlocked.Exchange(ref _videoJobCounted, 0) != 1) return;
        _monitor.VideoJobStopped();
        _monitor.GpuSampled -= OnGpuSample;
    }

    /// <summary>Error text that means a GPU/hardware path failed (so the ladder should move to the next rung).</summary>
    private static readonly string[] HardwareMarkers =
    [
        // NVIDIA
        "cuda", "nvenc", "cuvid", "nvdec", "openencodesessionex", "no capable devices",
        // Generic hardware frames / devices / tone mapping
        "vulkan", "libplacebo", "hwaccel", "hw_frames", "hwupload", "hwdownload", "device creation failed", "failed to create hw",
        // Intel Quick Sync
        "qsv", "mfx", "libvpl", "onevpl",
        // AMD AMF
        "amf", "amfcontext",
        // VA-API
        "vaapi", "libva", "va_", "vainitialize", "drm device",
        // Apple VideoToolbox
        "videotoolbox", "vtcompression", "vtdecompression", "vt_",
        // Direct3D 11 video
        "d3d11", "dxva",
    ];

    public static string ClassifyFailure(string stderr)
    {
        var e = stderr.ToLowerInvariant();
        if (HardwareMarkers.Any(e.Contains)) return "hardware";
        if (e.Contains("http error") || e.Contains("connection") || e.Contains("i/o error") || e.Contains("end of file") && e.Contains("http"))
            return "source";
        if (e.Contains("invalid data") || e.Contains("error while decoding") || e.Contains("decoding error"))
            return "decode";
        return "unknown";
    }

    /// <summary>Waits until a segment index is written (or the job ends). Resumes a throttled encoder.</summary>
    public async Task<bool> WaitForSegmentAsync(int index, TimeSpan timeout, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            RefreshPlaylist();
            lock (_gate)
            {
                if (_segments.Any(s => s.Index == index)) return true;
            }
            if (State == JobState.Throttled) Resume("segment wait");
            if (State is JobState.Failed or JobState.Cancelled or JobState.Completed) return false;
            await Task.Delay(150, ct);
        }
        return false;
    }

    public async Task<bool> WaitForFirstSegmentAsync(TimeSpan timeout, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            RefreshPlaylist();
            if (FirstSegmentAt is not null && InitSegmentReady)
            {
                if (TimelineStart is null) RefreshPlaylist();
                return true;
            }
            if (State is JobState.Failed or JobState.Cancelled) return false;
            if (State == JobState.Completed) return Segments.Count > 0;
            await Task.Delay(100, ct);
        }
        return false;
    }

    public async ValueTask DisposeAsync()
    {
        if (!_cts.IsCancellationRequested) _cts.Cancel();
        if (_process is { } p)
        {
            try
            {
                if (!p.HasExited)
                {
                    NativeProcess.Resume(p);
                    p.Kill(entireProcessTree: true);
                    await p.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                }
            }
            catch { /* already exited */ }
        }
        try { await _exited.Task.WaitAsync(TimeSpan.FromSeconds(3)); } catch { /* exit handler may not run if start failed */ }
        StopVideoCounting();
        _process?.Dispose();
        for (var i = 0; i < 5; i++)
        {
            try
            {
                if (System.IO.Directory.Exists(Directory)) System.IO.Directory.Delete(Directory, true);
                break;
            }
            catch (IOException) { await Task.Delay(200); }
            catch (UnauthorizedAccessException) { await Task.Delay(200); }
        }
    }
}
