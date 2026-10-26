using System.Collections.Concurrent;
using System.Diagnostics;
using Notflix.MediaEngine.Media;
using Notflix.MediaEngine.Security;

namespace Notflix.MediaEngine.Playback;

public sealed record SessionEvent(DateTimeOffset At, string Kind, string Message);

/// <summary>A text subtitle stream being extracted to WebVTT next to the HLS output.</summary>
public sealed class SubtitleExtraction
{
    public required int StreamIndex { get; init; }
    public required double StartSeconds { get; init; }
    public required string FilePath { get; init; }
    public Process? Process { get; set; }
    public bool Completed { get; set; }
    public bool Failed { get; set; }
}

public sealed class PlaybackSession
{
    private long _directBytes;
    private long _directMs;
    private int _directActive;
    private long _segmentRequests;
    private long _segmentLatencyTotalMs;

    public required string Id { get; init; }
    public required string Token { get; init; }
    public required string Owner { get; init; }
    public required TicketSource Source { get; init; }
    public required string Input { get; init; }
    public required bool IsRemote { get; init; }
    public required MediaProbe Probe { get; init; }
    public required string WorkDirectory { get; init; }
    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;
    public DateTimeOffset LastAccess { get; private set; } = DateTimeOffset.UtcNow;

    public ClientCapabilities Client { get; set; } = new();
    public PlaybackPreferences Prefs { get; set; } = new();
    public PlaybackDecision Decision { get; set; } = null!;
    public int? SubtitleIndex { get; set; }
    public int AttemptIndex { get; set; }
    public TranscodeJob? Job { get; set; }
    public int Generation { get; set; }
    public int Restarts { get; set; }
    public long ProbeMs { get; set; }
    public long? StartupMs { get; set; }
    public double LastViewerPosition { get; set; }
    public SemaphoreSlim Lock { get; } = new(1, 1);
    public ConcurrentDictionary<int, SubtitleExtraction> Subtitles { get; } = new();
    public ConcurrentQueue<SessionEvent> Events { get; } = new();
    public long? LastSegmentLatencyMs { get; private set; }
    public double? DirectThroughputMbps { get; private set; }
    public bool Disposed { get; set; }

    public bool IsDirect => Decision.Mode == PlaybackMode.DirectPlay;
    public bool DirectActive => Volatile.Read(ref _directActive) > 0;
    public long DirectBytes => Interlocked.Read(ref _directBytes);
    public long SegmentRequests => Interlocked.Read(ref _segmentRequests);
    public double? AverageSegmentLatencyMs =>
        SegmentRequests == 0 ? null : Math.Round(Interlocked.Read(ref _segmentLatencyTotalMs) / (double)SegmentRequests, 1);

    public void Touch() => LastAccess = DateTimeOffset.UtcNow;

    public void AddEvent(string kind, string message)
    {
        Events.Enqueue(new SessionEvent(DateTimeOffset.UtcNow, kind, message));
        while (Events.Count > 50 && Events.TryDequeue(out _)) { }
    }

    public void RecordSegment(long latencyMs)
    {
        Interlocked.Increment(ref _segmentRequests);
        Interlocked.Add(ref _segmentLatencyTotalMs, latencyMs);
        LastSegmentLatencyMs = latencyMs;
    }

    public void DirectStreamStarted() => Interlocked.Increment(ref _directActive);

    public void DirectStreamFinished(long bytes, long elapsedMs)
    {
        Interlocked.Decrement(ref _directActive);
        Interlocked.Add(ref _directBytes, bytes);
        Interlocked.Add(ref _directMs, elapsedMs);
        // Only meaningful for sizable transfers; tiny range probes would skew the estimate.
        if (bytes > 2_000_000 && elapsedMs > 200) DirectThroughputMbps = Math.Round(bytes * 8 / 1000.0 / elapsedMs, 1);
    }

    /// <summary>Movie-time (source time minus container start) at which the current generation begins.</summary>
    public double GenerationStart =>
        Job?.TimelineStart is { } t ? Math.Max(0, t - Probe.StartTime) : Job?.Spec.StartSeconds ?? 0;
}
