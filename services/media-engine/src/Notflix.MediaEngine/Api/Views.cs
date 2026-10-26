using Notflix.MediaEngine.Media;
using Notflix.MediaEngine.Monitoring;
using Notflix.MediaEngine.Playback;

namespace Notflix.MediaEngine.Api;

public sealed class ProbeRequest
{
    public string Ticket { get; set; } = "";
}

public sealed class CreateSessionRequest
{
    public string Ticket { get; set; } = "";
    public ClientCapabilities? Client { get; set; }
    public PlaybackPreferences? Preferences { get; set; }
    public int? AudioIndex { get; set; }
    public int? SubtitleIndex { get; set; }
    public double StartSeconds { get; set; }
}

public sealed class SeekRequest
{
    public double Position { get; set; }
    /// <summary>Restart the stream at Position even if it is already encoded (troubleshooting, tests).</summary>
    public bool Force { get; set; }
}

public sealed class TracksRequest
{
    public int? AudioIndex { get; set; }
    public int? SubtitleIndex { get; set; }
    public double Position { get; set; }
}

/// <summary>POST /config body. Unknown fields are ignored; out-of-range legacy numbers are ignored as before.</summary>
public sealed class RuntimeConfigRequest
{
    public int? MaxConcurrentVideoTranscodes { get; set; }
    public int? MaxTranscodeHeight { get; set; }
    public string? HardwareAcceleration { get; set; }
    public int? MaxAheadSeconds { get; set; }
    /// <summary>Set (possibly to null, meaning "clear") only when the body contains hardwareDevice.</summary>
    public bool HardwareDeviceSpecified { get; set; }
    public string? HardwareDevice { get; set; }
    public long? CacheMaxBytes { get; set; }

    /// <summary>Parses a JSON object (case-insensitive names). Throws <see cref="ArgumentException"/> with a readable message.</summary>
    public static RuntimeConfigRequest Parse(System.Text.Json.Nodes.JsonObject body)
    {
        var props = body.ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.OrdinalIgnoreCase);
        System.Text.Json.Nodes.JsonNode? Get(string name) => props.TryGetValue(name, out var v) ? v : null;
        int? Int(string name) => Get(name) is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<int>(out var i) ? i : null;
        var req = new RuntimeConfigRequest
        {
            MaxConcurrentVideoTranscodes = Int("maxConcurrentVideoTranscodes"),
            MaxTranscodeHeight = Int("maxTranscodeHeight"),
            MaxAheadSeconds = Int("maxAheadSeconds"),
        };
        if (Get("hardwareAcceleration") is { } hw)
        {
            var value = hw is System.Text.Json.Nodes.JsonValue hv && hv.TryGetValue<string>(out var str) ? str.Trim().ToLowerInvariant() : null;
            if (value is null || !HwBackends.RequestValues.Contains(value))
                throw new ArgumentException($"hardwareAcceleration must be one of {string.Join(", ", HwBackends.RequestValues)}.");
            req.HardwareAcceleration = value;
        }
        if (props.ContainsKey("hardwareDevice"))
        {
            req.HardwareDeviceSpecified = true;
            var dev = Get("hardwareDevice");
            if (dev is null) req.HardwareDevice = null;
            else if (dev is System.Text.Json.Nodes.JsonValue dv && dv.TryGetValue<string>(out var d))
            {
                d = d.Trim();
                if (d.Length == 0) req.HardwareDevice = null;
                else if (EngineConfig.ValidDevice(d)) req.HardwareDevice = d;
                else throw new ArgumentException("hardwareDevice must be null, a device index (\"0\") or a render node (\"/dev/dri/renderD128\").");
            }
            else throw new ArgumentException("hardwareDevice must be a string or null.");
        }
        if (Get("cacheMaxBytes") is { } cmb)
        {
            if (cmb is not System.Text.Json.Nodes.JsonValue cv || !cv.TryGetValue<long>(out var bytes) || bytes < EngineOptions.MinCacheMaxBytes)
                throw new ArgumentException($"cacheMaxBytes must be a whole number ≥ {EngineOptions.MinCacheMaxBytes} (512 MiB).");
            req.CacheMaxBytes = bytes;
        }
        return req;
    }
}

/// <summary>Builds JSON views. Never includes source URLs, tickets or session tokens (except on create).</summary>
public static class Views
{
    public static object Session(PlaybackSession s, bool includeToken = false)
    {
        var d = s.Decision;
        var job = s.Job;
        return new
        {
            id = s.Id,
            token = includeToken ? s.Token : null,
            mode = d.Mode.ToString(),
            modeLabel = d.ModeLabel,
            output = s.IsDirect ? "progressive" : "hls",
            generation = s.Generation,
            generationStart = Math.Round(s.GenerationStart, 3),
            durationSeconds = s.Probe.Duration is { } dur ? Math.Max(0, dur) : (double?)null,
            sourceStartTime = s.Probe.StartTime,
            startupMs = s.StartupMs,
            probeMs = s.ProbeMs,
            state = job?.State.ToString() ?? (s.IsDirect ? "Direct" : "Idle"),
            decision = new
            {
                video = d.Video.ToString(),
                audio = d.Audio.ToString(),
                outputVideoCodec = d.OutputVideoCodec,
                outputAudioCodec = d.OutputAudioCodec,
                width = d.OutputWidth,
                height = d.OutputHeight,
                targetVideoKbps = d.TargetVideoKbps,
                audioChannels = d.Audio == StreamAction.Transcode ? d.AudioChannels : (int?)null,
                pipeline = job?.Attempt?.Label ?? (d.Video == StreamAction.Transcode ? d.Attempts.ElementAtOrDefault(s.AttemptIndex)?.Label : null),
                hardwareDecode = job?.Attempt?.HardwareDecode,
                hardwareEncode = job?.Attempt?.HardwareEncode,
                tonemap = job?.Attempt?.Tonemap.ToString(),
                burnSubtitleIndex = d.BurnSubtitleIndex,
                reasons = d.Reasons,
            },
            tracks = new
            {
                audio = s.Probe.Audio.Select(a => new
                {
                    index = a.Index, codec = a.Codec, language = a.Language, title = a.Title,
                    channels = a.Channels, channelLayout = a.ChannelLayout, @default = a.Default,
                    sampleRate = a.SampleRate, bitrateKbps = a.BitRate / 1000, languageCode = Languages.Normalize(a.Language),
                }),
                subtitles = s.Probe.Subtitles.Select(t => new
                {
                    index = t.Index, codec = t.Codec, language = t.Language, title = t.Title,
                    forced = t.Forced, @default = t.Default, kind = t.IsText ? "text" : t.IsImage ? "image" : "other",
                    languageCode = Languages.Normalize(t.Language),
                }),
                selectedAudio = d.AudioStreamIndex,
                selectedAudioLanguage = d.SelectedAudioLanguage,
                audioLanguageMatched = d.AudioLanguageMatched,
                availableAudioLanguages = d.AvailableAudioLanguages,
                selectedSubtitle = s.SubtitleIndex,
            },
            source = SourceView(s),
        };
    }

    public static object SourceView(PlaybackSession s) =>
        SourceView(s.Probe, s.Source, s.IsRemote ? Path.GetFileName(new Uri(s.Input).AbsolutePath) : Path.GetFileName(s.Input));

    /// <summary>Verified stream view; also used by the probe-only endpoint (source selector).</summary>
    public static object SourceView(MediaProbe p, Security.TicketSource src, string fileNameFromInput)
    {
        var v = p.Video;
        return new
        {
            provider = src.Provider,
            title = src.Title,
            fileName = src.FileName ?? fileNameFromInput,
            fileSize = src.FileSize ?? p.Size,
            container = p.Container,
            formatName = p.FormatName,
            durationSeconds = p.Duration,
            bitrateKbps = p.BitRate / 1000,
            video = v is null ? null : new
            {
                codec = v.Codec, profile = v.Profile, level = v.Level, width = v.Width, height = v.Height,
                pixelFormat = v.PixelFormat, bitDepth = v.BitDepth, frameRate = v.FrameRate, bitrateKbps = v.BitRate / 1000,
                dynamicRange = v.DynamicRange, colorTransfer = v.ColorTransfer, colorPrimaries = v.ColorPrimaries,
                dolbyVisionProfile = v.DolbyVisionProfile,
            },
            audio = p.Audio.Select(a => new { index = a.Index, codec = a.Codec, channels = a.Channels, channelLayout = a.ChannelLayout, sampleRate = a.SampleRate, language = a.Language, languageCode = Languages.Normalize(a.Language), title = a.Title, @default = a.Default, bitrateKbps = a.BitRate / 1000 }),
            subtitles = p.Subtitles.Select(t => new { index = t.Index, codec = t.Codec, language = t.Language, languageCode = Languages.Normalize(t.Language), title = t.Title, forced = t.Forced, @default = t.Default, kind = t.IsText ? "text" : t.IsImage ? "image" : "other" }),
            audioLanguages = p.Audio.Select(a => Languages.Normalize(a.Language)).OfType<string>().Distinct(),
            subtitleLanguages = p.Subtitles.Select(t => Languages.Normalize(t.Language)).OfType<string>().Distinct(),
            untaggedAudioTracks = p.Audio.Count(a => Languages.Normalize(a.Language) is null),
        };
    }

    public static object Status(PlaybackSession s)
    {
        var job = s.Job;
        var genStart = s.GenerationStart;
        double? evictedUntil = null;
        if (job is not null && job.EvictedBefore > 0)
        {
            var kept = job.Segments.FirstOrDefault(x => x.Index >= job.EvictedBefore);
            evictedUntil = Math.Round(genStart + (kept?.Start ?? job.ProducedDuration), 2);
        }
        return new
        {
            id = s.Id,
            mode = s.Decision.Mode.ToString(),
            generation = s.Generation,
            generationStart = Math.Round(genStart, 3),
            state = job?.State.ToString() ?? (s.IsDirect ? "Direct" : "Idle"),
            producedUntil = job is null ? (double?)null : Math.Round(genStart + job.ProducedDuration, 2),
            evictedUntil,
            ended = job?.Ended ?? false,
            speed = job?.Progress.Speed,
            error = job?.State == JobState.Failed ? job.Error : null,
            restarts = s.Restarts,
        };
    }

    public static object Metrics(PlaybackSession s, SystemMonitor monitor, HardwareCapabilities hw)
    {
        var job = s.Job;
        var gpu = monitor.LatestGpu;
        var progress = job?.Progress;
        var genStart = s.GenerationStart;
        return new
        {
            sessionId = s.Id,
            at = DateTimeOffset.UtcNow,
            mode = s.Decision.Mode.ToString(),
            modeLabel = s.Decision.ModeLabel,
            status = Status(s),
            source = SourceView(s),
            output = new
            {
                container = s.IsDirect ? s.Probe.Container : "hls-fmp4",
                videoCodec = s.Decision.OutputVideoCodec,
                audioCodec = s.Decision.OutputAudioCodec,
                width = s.Decision.OutputWidth,
                height = s.Decision.OutputHeight,
                targetVideoKbps = s.Decision.TargetVideoKbps,
                // ffmpeg's -progress bitrate is the measured output rate of what it has written.
                measuredBitrateKbps = progress?.BitrateKbps,
            },
            processing = new
            {
                active = job is not null && job.State is JobState.Running or JobState.Throttled or JobState.Starting,
                host = Environment.MachineName,
                pipeline = job?.Attempt?.Label ?? s.Decision.ModeLabel,
                videoAction = s.Decision.Video.ToString(),
                audioAction = s.Decision.Audio.ToString(),
                encoder = job?.Attempt?.Encoder ?? (s.Decision.Video == StreamAction.Copy ? "copy" : null),
                hardwareEncode = job?.Attempt?.HardwareEncode ?? false,
                hardwareDecode = job?.Attempt?.HardwareDecode ?? false,
                tonemap = job?.Attempt?.Tonemap.ToString(),
                state = job?.State.ToString(),
                generation = s.Generation,
                speed = progress?.Speed,
                fps = progress?.Fps,
                frames = progress?.Frame,
                droppedFrames = progress?.DropFrames,
                duplicatedFrames = progress?.DupFrames,
                encodedUntil = job is null ? (double?)null : Math.Round(genStart + job.ProducedDuration, 2),
                segments = job?.Segments.Count,
                firstSegmentMs = job?.FirstSegmentAt is { } f ? (long)(f - job.StartedAt).TotalMilliseconds : (long?)null,
                processId = job?.ProcessId,
                processCpuPercent = job?.ProcessCpuPercent,
                processMemoryMiB = job?.ProcessMemoryMiB,
                restarts = s.Restarts,
                error = job?.State == JobState.Failed ? job.Error : null,
            },
            gpu = new
            {
                available = gpu is not null,
                name = hw.GpuName,
                driver = hw.DriverVersion,
                sampledAt = gpu?.At,
                // These are GPU-wide counters from nvidia-smi, not per-process.
                utilizationPercent = gpu?.GpuPercent,
                encoderPercent = gpu?.EncoderPercent,
                decoderPercent = gpu?.DecoderPercent,
                memoryUsedMiB = gpu?.MemoryUsedMiB,
                memoryTotalMiB = gpu?.MemoryTotalMiB,
                temperatureC = gpu?.TemperatureC,
                powerW = gpu?.PowerW,
                peakEncoderPercentThisJob = job?.IsVideoTranscode == true ? job.PeakEncoderPercent : (double?)null,
                peakDecoderPercentThisJob = job?.IsVideoTranscode == true ? job.PeakDecoderPercent : (double?)null,
            },
            system = new { cpuPercent = monitor.CpuPercent, logicalProcessors = Environment.ProcessorCount },
            network = new
            {
                directBytes = s.DirectBytes,
                directThroughputMbps = s.DirectThroughputMbps,
                segmentRequests = s.SegmentRequests,
                averageSegmentLatencyMs = s.AverageSegmentLatencyMs,
                lastSegmentLatencyMs = s.LastSegmentLatencyMs,
            },
            timing = new { startupMs = s.StartupMs, probeMs = s.ProbeMs },
            decisionReasons = s.Decision.Reasons,
            events = s.Events.Select(e => new { at = e.At, kind = e.Kind, message = e.Message }),
        };
    }

    public static object Selection(BackendSelection sel) => new
    {
        requested = sel.Requested,
        effective = sel.Effective,
        device = sel.Device,
        fallbackReason = sel.FallbackReason,
    };

    public static object Capabilities(HardwareCapabilities hw, EngineOptions options, SessionManager sessions, SystemMonitor monitor, long? cacheUsedBytes = null)
    {
        var selection = BackendSelector.Select(hw, options.HardwareAcceleration, options.HardwareDevice);
        var hwDecodeVerified = hw.VerifiedHardwareDecoders.Concat(hw.DecodePaths.Values.SelectMany(p => p.Verified)).Distinct().Order();
        return new
        {
            version = EngineOptions.Version,
            host = Environment.MachineName,
            platform = new { os = hw.Platform.Os, arch = hw.Platform.Arch, osDescription = hw.Platform.OsDescription },
            ffmpeg = new { available = hw.FfmpegAvailable, version = hw.FfmpegVersion, path = hw.FfmpegPath },
            ffprobe = new { available = hw.FfprobeAvailable, version = hw.FfprobeVersion, path = hw.FfprobePath },
            gpu = new { name = hw.GpuName, driver = hw.DriverVersion, memoryMiB = hw.GpuMemoryMiB, monitoring = monitor.GpuMonitoringAvailable },
            encoders = new { verified = hw.VerifiedEncoders.Order(), software = hw.SoftwareEncoders.Order() },
            hardwareDecoders = new { verified = hwDecodeVerified, listedUnverified = hw.ListedHardwareDecoders.Except(hw.VerifiedHardwareDecoders).Order() },
            tonemapping = new { libplacebo = hw.LibplaceboTonemap, cpu = hw.CpuTonemap },
            adapters = hw.Adapters.Select(a => new { id = a.Id, name = a.Name, vendor = a.Vendor, driver = a.Driver, @virtual = a.Virtual, memoryMiB = a.MemoryMiB }),
            backends = hw.Backends.Select(b => new
            {
                id = b.Id, label = b.Label, vendor = b.Vendor, kind = b.Kind, status = b.Status,
                encoders = b.Encoders, decoders = b.Decoders, device = b.Device, notes = b.Notes,
            }),
            selection = Selection(selection),
            software = new
            {
                encoders = hw.SoftwareEncoders.Order(),
                directPlay = true,
                remux = hw.FfmpegAvailable,
                audioTranscode = hw.FfmpegAvailable && hw.SoftwareEncoders.Contains("aac"),
            },
            cache = new
            {
                directory = options.CacheDirectory,
                engineDirectory = options.TempDirectory,
                maxBytes = options.CacheMaxBytes,
                usedBytes = cacheUsedBytes,
            },
            limits = new
            {
                options.MaxConcurrentVideoTranscodes, options.MaxConcurrentJobs, options.MaxTranscodeHeight,
                options.MaxAheadSeconds, options.BackBufferSeconds, options.SegmentSeconds, options.HardwareAcceleration,
                options.HardwareDevice, options.CacheMaxBytes,
            },
            load = new { sessions = sessions.All.Count, activeJobs = sessions.ActiveJobs, activeVideoTranscodes = sessions.ActiveVideoTranscodes },
            detectedAt = hw.DetectedAt,
            detectionSeconds = hw.DetectionSeconds,
        };
    }
}
