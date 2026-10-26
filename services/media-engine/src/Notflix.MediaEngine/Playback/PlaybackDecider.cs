using Notflix.MediaEngine.Media;

namespace Notflix.MediaEngine.Playback;

/// <summary>
/// Chooses the cheapest pipeline that produces something the viewer's browser can play:
///   Direct Play  → original bytes over HTTP range requests
///   Remux        → copy video + audio into HLS fMP4 (container incompatible only)
///   Audio        → copy video, transcode audio to AAC
///   Video        → hardware transcode on the selected backend (NVENC/QSV/AMF/VAAPI/VideoToolbox),
///                  ladder: HW decode + HW encode → CPU decode + HW encode → CPU decode + x264
/// Pure function of its inputs so every branch is unit tested.
/// </summary>
public static class PlaybackDecider
{
    private static readonly HashSet<string> NoCodecs = [];

    public static PlaybackDecision Decide(
        MediaProbe probe,
        ClientCapabilities client,
        PlaybackPreferences prefs,
        HardwareCapabilities hw,
        EngineOptions options,
        int? requestedAudioIndex = null,
        int? requestedSubtitleIndex = null)
    {
        var reasons = new List<string>();
        var video = probe.Video ?? throw new InvalidOperationException("Source has no video stream.");
        var audio = SelectAudio(probe, requestedAudioIndex, prefs);
        var audioLang = audio is null ? null : Languages.Normalize(audio.Language);
        var preferredLangs = prefs.OrderedAudioLanguages().ToList();
        bool? langMatched = audio is null || preferredLangs.Count == 0 || audioLang is null ? null : preferredLangs.Contains(audioLang);
        var availableLangs = probe.Audio.Select(a => Languages.Normalize(a.Language)).OfType<string>().Distinct().ToList();

        int? burn = null;
        if (requestedSubtitleIndex is { } subIdx)
        {
            var sub = probe.Subtitles.FirstOrDefault(s => s.Index == subIdx);
            if (sub is { IsImage: true })
            {
                burn = sub.Index;
                reasons.Add($"Image subtitles ({sub.Codec}) are drawn into the picture");
            }
        }

        var maxHeight = Math.Min(prefs.MaxHeight > 0 ? prefs.MaxHeight : 2160, client.MaxHeight ?? int.MaxValue);
        if (prefs.Quality == "data-saver") maxHeight = Math.Min(maxHeight, 720);

        var directVideoOk = VideoSupported(video, client.DirectVideo, client, prefs, maxHeight, out var directVideoWhy);
        var mseVideoOk = VideoSupported(video, client.MseVideo, client, prefs, maxHeight, out var mseVideoWhy);
        var directAudioOk = audio is null || client.DirectAudio.Contains(NormalizeAudio(audio.Codec));
        var mseAudioOk = audio is null || client.MseAudio.Contains(NormalizeAudio(audio.Codec));
        var container = probe.Container;
        var directContainer = container is "mp4" or "webm";
        var firstAudio = audio is null || probe.Audio.Count == 0 || probe.Audio[0].Index == audio.Index;

        var forced = prefs.ForceMode?.ToLowerInvariant();

        // Mode A — direct play.
        if (forced is null && prefs.AllowDirectPlay && burn is null && directContainer && directVideoOk && directAudioOk && firstAudio)
        {
            reasons.Add($"Browser plays {Describe(video)} and {DescribeAudio(audio)} in {container.ToUpperInvariant()} natively");
            return new PlaybackDecision
            {
                Mode = PlaybackMode.DirectPlay,
                Video = StreamAction.Copy,
                Audio = audio is null ? StreamAction.None : StreamAction.Copy,
                AudioStreamIndex = audio?.Index,
                SelectedAudioLanguage = audioLang,
                AudioLanguageMatched = langMatched,
                AvailableAudioLanguages = availableLangs,
                OutputVideoCodec = video.Codec,
                OutputAudioCodec = audio?.Codec ?? "none",
                OutputWidth = video.Width,
                OutputHeight = video.Height,
                Reasons = reasons,
            };
        }
        if (!directContainer) reasons.Add($"{container.ToUpperInvariant()} container is not playable directly in browsers");
        else if (!firstAudio) reasons.Add("Selected audio track is not the file's first track");
        else if (!directVideoOk && directVideoWhy is not null) reasons.Add(directVideoWhy);
        else if (!directAudioOk) reasons.Add($"Browser cannot play {audio!.Codec.ToUpperInvariant()} audio directly");

        // Mode B — remux.
        if (burn is null && mseVideoOk && mseAudioOk && forced is null or "remux")
        {
            reasons.Add("Video and audio are copied into a browser-friendly stream (no re-encoding)");
            return new PlaybackDecision
            {
                Mode = PlaybackMode.Remux,
                Video = StreamAction.Copy,
                Audio = audio is null ? StreamAction.None : StreamAction.Copy,
                AudioStreamIndex = audio?.Index,
                SelectedAudioLanguage = audioLang,
                AudioLanguageMatched = langMatched,
                AvailableAudioLanguages = availableLangs,
                OutputVideoCodec = video.Codec,
                OutputAudioCodec = audio?.Codec ?? "none",
                OutputWidth = video.Width,
                OutputHeight = video.Height,
                Reasons = reasons,
            };
        }

        var (channels, audioKbps) = AudioTarget(audio, prefs);

        // Mode C — audio-only transcode.
        if (burn is null && mseVideoOk && forced is null or "remux" or "audio")
        {
            if (!mseAudioOk) reasons.Add($"{audio!.Codec.ToUpperInvariant()} audio is converted to AAC; video is copied untouched");
            return new PlaybackDecision
            {
                Mode = PlaybackMode.AudioTranscode,
                Video = StreamAction.Copy,
                Audio = audio is null ? StreamAction.None : StreamAction.Transcode,
                AudioStreamIndex = audio?.Index,
                SelectedAudioLanguage = audioLang,
                AudioLanguageMatched = langMatched,
                AvailableAudioLanguages = availableLangs,
                OutputVideoCodec = video.Codec,
                OutputAudioCodec = audio is null ? "none" : "aac",
                OutputWidth = video.Width,
                OutputHeight = video.Height,
                AudioChannels = channels,
                AudioKbps = audioKbps,
                Reasons = reasons,
            };
        }
        if (!mseVideoOk && mseVideoWhy is not null) reasons.Add(mseVideoWhy);

        // Mode D/E — video transcode with hardware → software fallback ladder.
        var outHeight = Math.Min(EvenFloor(video.Height), EvenFloor(Math.Min(maxHeight, options.MaxTranscodeHeight)));
        if (outHeight <= 0) outHeight = Math.Min(1080, EvenFloor(Math.Max(video.Height, 2)));
        var outWidth = video.Height > 0 ? EvenFloor((int)Math.Round(video.Width * (double)outHeight / video.Height)) : 1920;

        // Backend: the session's explicit choice wins over the engine setting; "off" anywhere means CPU.
        var prefHw = BackendSelector.Normalize(prefs.HardwareAcceleration);
        var engineHw = BackendSelector.Normalize(options.HardwareAcceleration);
        var requestedHw = engineHw == "off" || prefHw == "off" ? "off" : prefHw != "auto" ? prefHw : engineHw;
        var selection = BackendSelector.Select(hw, requestedHw, requestedHw == engineHw ? options.HardwareDevice : null);
        if (selection.FallbackReason is not null) reasons.Add(selection.FallbackReason);
        var backend = selection.Effective;
        var hwAllowed = backend != "software";
        var useHevcOut = hwAllowed && hw.VerifiedEncoders.Contains(HwBackends.EncoderName(backend, "hevc")) &&
                         outHeight > 1440 && client.MseVideo.Contains("hevc");
        var hwEncoder = hwAllowed ? HwBackends.EncoderName(backend, useHevcOut ? "hevc" : "h264") : null;
        var device = hwAllowed && hw.Devices.TryGetValue(backend, out var dev) ? dev : null;

        // Hardware decode: NVDEC for NVENC (full-GPU path), otherwise the verified decode path paired with the backend.
        HwDecodePath? decodePath = null;
        var hwDecode = false;
        if (backend == "nvenc") hwDecode = CanHardwareDecode(video, hw);
        else if (hwAllowed && hw.DecodePaths.TryGetValue(backend, out var path))
        {
            decodePath = path;
            hwDecode = CanHardwareDecode(video, path.Verified, NoCodecs);
        }

        var tonemap = TonemapMethod.None;
        if (video.IsHdr)
        {
            if (hw.LibplaceboTonemap) tonemap = TonemapMethod.Libplacebo;
            else if (hw.CpuTonemap) tonemap = TonemapMethod.Cpu;
            // VAAPI encoders take frames uploaded to the VAAPI device, which cannot share the filter device with Vulkan.
            if (backend == "vaapi" && tonemap == TonemapMethod.Libplacebo) tonemap = hw.CpuTonemap ? TonemapMethod.Cpu : TonemapMethod.None;
            reasons.Add(tonemap == TonemapMethod.None
                ? $"{video.DynamicRange} source; tone mapping unavailable so colors may look washed out"
                : $"{video.DynamicRange} is tone mapped to SDR ({(tonemap == TonemapMethod.Libplacebo ? "GPU, libplacebo" : "CPU, zscale")})");
        }

        var attempts = new List<PipelineAttempt>();
        if (hwEncoder is not null)
        {
            var encLabel = $"{HwBackends.ShortName(backend)} {(useHevcOut ? "HEVC" : "H.264")}";
            var deviceArgs = device?.PreInputArgs ?? [];
            var encoderArgs = device?.EncoderArgs ?? [];
            if (hwDecode)
            {
                if (backend == "nvenc")
                    attempts.Add(new PipelineAttempt($"NVDEC + {encLabel}", true, hwEncoder, tonemap)
                    {
                        DecodeArgs = device?.HwaccelArgs is { Count: > 0 } ha ? ["-hwaccel", "cuda", .. ha] : null,
                        EncoderDeviceArgs = encoderArgs,
                    });
                else
                    attempts.Add(new PipelineAttempt($"{decodePath!.Label} + {encLabel}", true, hwEncoder, tonemap)
                    {
                        Hwaccel = decodePath.Hwaccel, DecodeArgs = decodePath.InputArgs, DeviceArgs = deviceArgs, EncoderDeviceArgs = encoderArgs,
                    });
            }
            attempts.Add(new PipelineAttempt($"CPU decode + {encLabel}", false, hwEncoder, tonemap)
            {
                DeviceArgs = deviceArgs, EncoderDeviceArgs = encoderArgs,
            });
        }
        // The last-resort rung avoids the GPU entirely when it can (CPU tone mapping).
        var cpuTonemap = tonemap == TonemapMethod.None ? TonemapMethod.None
            : hw.CpuTonemap ? TonemapMethod.Cpu
            : tonemap;
        attempts.Add(new PipelineAttempt("CPU decode + x264", false, "libx264", cpuTonemap));

        var target = TargetVideoKbps(outHeight, prefs.Quality, useHevcOut);
        if (video.BitRate is > 0) target = Math.Min(target, (int)(video.BitRate.Value / 1000 * 1.2) + 500);
        if (prefs.MaxBitrateKbps is > 0) target = Math.Min(target, prefs.MaxBitrateKbps.Value);
        if (outHeight < video.Height) reasons.Add($"Scaled from {video.Height}p to {outHeight}p");

        var outAudio = audio is null ? StreamAction.None : mseAudioOk && forced != "video" ? StreamAction.Copy : StreamAction.Transcode;
        return new PlaybackDecision
        {
            Mode = PlaybackMode.VideoTranscode,
            Video = StreamAction.Transcode,
            Audio = outAudio,
            AudioStreamIndex = audio?.Index,
            SelectedAudioLanguage = audioLang,
            AudioLanguageMatched = langMatched,
            AvailableAudioLanguages = availableLangs,
            BurnSubtitleIndex = burn,
            OutputVideoCodec = useHevcOut ? "hevc" : "h264",
            OutputAudioCodec = outAudio switch { StreamAction.Copy => audio!.Codec, StreamAction.Transcode => "aac", _ => "none" },
            OutputWidth = outWidth,
            OutputHeight = outHeight,
            TargetVideoKbps = target,
            AudioChannels = channels,
            AudioKbps = audioKbps,
            Attempts = attempts,
            Reasons = reasons,
        };
    }

    public static AudioStreamInfo? SelectAudio(MediaProbe probe, int? requested, string? language) =>
        SelectAudio(probe, requested, new PlaybackPreferences { AudioLanguage = language ?? "" });

    /// <summary>
    /// Picks the audio track: an explicit request wins; then the first preferred language the file
    /// actually carries (tags normalised, commentary skipped, surround preferred when asked); then
    /// the file's default track; then the first track. An untagged track never counts as a language
    /// match — the caller reports it as unknown.
    /// </summary>
    public static AudioStreamInfo? SelectAudio(MediaProbe probe, int? requested, PlaybackPreferences prefs)
    {
        if (probe.Audio.Count == 0) return null;
        if (requested is { } idx)
        {
            var match = probe.Audio.FirstOrDefault(a => a.Index == idx);
            if (match is not null) return match;
        }
        static bool Commentary(AudioStreamInfo a) =>
            (a.Title ?? "").Contains("comment", StringComparison.OrdinalIgnoreCase) ||
            (a.Title ?? "").Contains("descriptive", StringComparison.OrdinalIgnoreCase);
        IOrderedEnumerable<AudioStreamInfo> Rank(IEnumerable<AudioStreamInfo> tracks) =>
            tracks.OrderByDescending(a => prefs.Surround ? a.Channels : -Math.Abs(a.Channels - 2))
                  .ThenByDescending(a => a.Default);

        foreach (var lang in prefs.OrderedAudioLanguages())
        {
            var hit = Rank(probe.Audio.Where(a => Languages.Matches(a.Language, lang) && !Commentary(a))).FirstOrDefault();
            if (hit is not null) return hit;
        }
        return Rank(probe.Audio.Where(a => a.Default && !Commentary(a))).FirstOrDefault()
               ?? probe.Audio.FirstOrDefault(a => !Commentary(a))
               ?? probe.Audio[0];
    }

    public static bool VideoSupported(
        VideoStreamInfo v,
        IReadOnlyCollection<string> supported,
        ClientCapabilities client,
        PlaybackPreferences prefs,
        int maxHeight,
        out string? why)
    {
        var codec = NormalizeVideo(v.Codec);
        if (!supported.Contains(codec))
        {
            why = $"Browser cannot decode {CodecName(codec)} video";
            return false;
        }
        var pix = v.PixelFormat ?? "yuv420p";
        if (pix.Contains("422") || pix.Contains("444"))
        {
            why = $"{CodecName(codec)} with {pix} chroma is not browser-compatible";
            return false;
        }
        if (v.BitDepth > 8)
        {
            if (codec == "h264")
            {
                why = "10-bit H.264 (Hi10P) is not supported by browsers";
                return false;
            }
            if (!client.TenBit.Contains(codec))
            {
                why = $"Browser cannot decode 10-bit {CodecName(codec)}";
                return false;
            }
        }
        if (v.DolbyVisionProfile == 5 || (v.DynamicRange == "Dolby Vision" && v.DolbyVisionProfile is null))
        {
            why = "Dolby Vision without an HDR10 base layer needs conversion";
            return false;
        }
        if (v.Height > maxHeight + 8)
        {
            why = $"Source is {v.Height}p; quality limit is {maxHeight}p";
            return false;
        }
        if (prefs.MaxBitrateKbps is > 0 && v.BitRate is > 0 && v.BitRate.Value / 1000 > prefs.MaxBitrateKbps.Value)
        {
            why = $"Source bitrate exceeds the {prefs.MaxBitrateKbps} kbps limit";
            return false;
        }
        why = null;
        return true;
    }

    /// <summary>NVDEC: verified codecs plus listed-but-unexercisable ones (VC-1, VP8).</summary>
    public static bool CanHardwareDecode(VideoStreamInfo v, HardwareCapabilities hw) =>
        CanHardwareDecode(v, hw.VerifiedHardwareDecoders, hw.ListedHardwareDecoders);

    public static bool CanHardwareDecode(VideoStreamInfo v, IReadOnlySet<string> verified, IReadOnlySet<string> listed)
    {
        var codec = NormalizeVideo(v.Codec);
        var known = verified.Contains(codec) || listed.Contains(codec);
        if (!known) return false;
        var pix = v.PixelFormat ?? "";
        if (pix.Contains("422") || pix.Contains("444")) return false; // hardware decoders: 4:2:0 only on most parts
        if (codec == "h264" && v.BitDepth > 8) return false;           // no consumer decoder does H.264 High10
        return v.BitDepth <= 10 || codec == "hevc";
    }

    private static (int channels, int kbps) AudioTarget(AudioStreamInfo? audio, PlaybackPreferences prefs)
    {
        if (audio is null) return (2, 0);
        if (prefs.Surround && audio.Channels >= 6) return (6, 384);
        return (2, prefs.Quality == "data-saver" ? 128 : 192);
    }

    public static int TargetVideoKbps(int height, string quality, bool hevc)
    {
        var (best, balanced, saver) = height switch
        {
            > 1440 => (20000, 14000, 8000),
            > 1080 => (12000, 9000, 5000),
            > 720 => (8000, 6000, 3500),
            > 480 => (4500, 3500, 2000),
            _ => (2000, 1500, 1000),
        };
        var kbps = quality switch { "balanced" => balanced, "data-saver" => saver, _ => best };
        return hevc ? (int)(kbps * 0.7) : kbps;
    }

    public static string NormalizeVideo(string codec) => codec.ToLowerInvariant() switch
    {
        "h265" or "hevc" => "hevc",
        "avc" or "avc1" or "h264" => "h264",
        "libdav1d" or "av1" => "av1",
        var c => c,
    };

    public static string NormalizeAudio(string codec) => codec.ToLowerInvariant() switch
    {
        var c when c.StartsWith("pcm_") => "pcm",
        "dca" => "dts",
        var c => c,
    };

    private static int EvenFloor(int v) => v - (v % 2);

    private static string CodecName(string codec) => codec switch
    {
        "h264" => "H.264",
        "hevc" => "HEVC",
        "av1" => "AV1",
        "vp9" => "VP9",
        "vp8" => "VP8",
        "mpeg2video" => "MPEG-2",
        "mpeg4" => "MPEG-4 Part 2",
        "vc1" => "VC-1",
        var c => c.ToUpperInvariant(),
    };

    private static string Describe(VideoStreamInfo v) =>
        $"{CodecName(NormalizeVideo(v.Codec))}{(v.BitDepth > 8 ? $" {v.BitDepth}-bit" : "")}";

    private static string DescribeAudio(AudioStreamInfo? a) => a is null ? "no audio" : a.Codec.ToUpperInvariant();
}
