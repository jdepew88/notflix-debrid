using System.Globalization;
using Notflix.MediaEngine.Media;

namespace Notflix.MediaEngine.Playback;

public sealed record HlsJobSpec(
    string Input,
    bool IsRemote,
    MediaProbe Probe,
    PlaybackDecision Decision,
    PipelineAttempt? Attempt,
    double StartSeconds,
    string OutputDirectory,
    int SegmentSeconds,
    /// <summary>
    /// The session already probed the source, so FFmpeg's own stream analysis can be short.
    /// That avoids a second multi-second probe of large remote files before the first segment.
    /// The session retries with full analysis if a file needs it.
    /// </summary>
    bool FastProbe = true);

/// <summary>
/// Builds FFmpeg argument lists (ArgumentList, never a shell string) for HLS fMP4 output.
/// Timestamps are preserved (-copyts) so every generation of a session shares the source timeline;
/// the session derives the exact start from the first segment's tfdt.
/// </summary>
public static class FfmpegArgsBuilder
{
    public const string PlaylistName = "index.m3u8";
    public const string InitName = "init.mp4";
    public const string SegmentPattern = "seg_%05d.m4s";

    public static List<string> InputArgs(bool isRemote)
    {
        var args = new List<string>();
        if (isRemote)
        {
            args.AddRange([
                "-reconnect", "1",
                "-reconnect_streamed", "1",
                "-reconnect_on_network_error", "1",
                "-reconnect_on_http_error", "5xx",
                "-reconnect_delay_max", "15",
                "-rw_timeout", "30000000",
                "-user_agent", MediaProber.UserAgent,
            ]);
        }
        return args;
    }

    public static List<string> BuildHls(HlsJobSpec spec)
    {
        var d = spec.Decision;
        var video = spec.Probe.Video!;
        var attempt = spec.Attempt;
        var transcodeVideo = d.Video == StreamAction.Transcode;
        if (transcodeVideo && attempt is null) throw new ArgumentException("video transcode requires a pipeline attempt");

        var args = new List<string>
        {
            "-hide_banner", "-nostdin", "-y",
            "-loglevel", "error",
            "-progress", "pipe:1", "-stats_period", "1",
        };

        // GPU/filter device setup must precede the input.
        var gpuFrames = false;
        if (transcodeVideo)
        {
            if (attempt!.Tonemap == TonemapMethod.Libplacebo)
                args.AddRange(["-init_hw_device", "vulkan=vk", "-filter_hw_device", "vk"]);
            // Encoder device (VAAPI: device + filter device for hwupload).
            args.AddRange(attempt.DeviceArgs);
            if (attempt.HardwareDecode && attempt.DecodeHwaccel == "cuda")
            {
                args.AddRange(attempt.DecodeArgs ?? ["-hwaccel", "cuda"]);
                // Keep frames on the GPU unless a CPU/Vulkan filter needs them in system memory.
                gpuFrames = attempt.Tonemap == TonemapMethod.None && d.BurnSubtitleIndex is null;
                // No -extra_hw_frames: HEVC's 16-frame DPB plus extras exceeds the NVDEC surface pool
                // (cuvidCreateDecoder → CUDA_ERROR_INVALID_VALUE) and ffmpeg silently falls back to CPU.
                if (gpuFrames) args.AddRange(["-hwaccel_output_format", "cuda"]);
            }
            else if (attempt.HardwareDecode)
            {
                // D3D11VA / VAAPI / VideoToolbox: no output format, so decoded frames are downloaded to
                // system memory, scaled on the CPU and (for VAAPI) uploaded again for the encoder.
                args.AddRange(attempt.DecodeArgs ?? ["-hwaccel", attempt.DecodeHwaccel]);
            }
        }

        args.AddRange(InputArgs(spec.IsRemote));
        if (spec.FastProbe)
            args.AddRange(["-probesize", "5000000", "-analyzeduration", "1500000"]);
        if (spec.StartSeconds > 0.05)
        {
            // Copied video starts at the keyframe before the target. Accurate seeking would trim the
            // (re-encoded) audio to the exact target instead, leaving the first seconds with video
            // but no audio, which MSE treats as unbuffered. Start both tracks at the keyframe.
            if (!transcodeVideo) args.Add("-noaccurate_seek");
            args.AddRange(["-ss", Num(spec.StartSeconds)]);
        }
        args.AddRange(["-copyts", "-i", spec.Input]);

        string? complexOut = null;
        if (transcodeVideo)
        {
            var chain = VideoFilterChain(d, attempt!, video, gpuFrames);
            if (d.BurnSubtitleIndex is { } sub)
            {
                // Overlay needs system-memory frames; tone map first so subtitles stay SDR-correct.
                var pre = attempt!.Tonemap switch
                {
                    TonemapMethod.Libplacebo => $"{TonemapLibplacebo(video.Width, video.Height)},",
                    TonemapMethod.Cpu => $"{TonemapCpu(video.Width, video.Height)},",
                    _ => "",
                };
                var post = $"scale={d.OutputWidth}:{d.OutputHeight},format={SoftwarePixFmt(attempt.Encoder)}{Upload(attempt)}";
                args.AddRange(["-filter_complex",
                    $"[0:v:0]{pre}null[base];[base][0:{sub}]overlay=eof_action=pass:repeatlast=0,{post}[vout]"]);
                complexOut = "[vout]";
            }
            else if (chain.Length > 0)
            {
                args.AddRange(["-vf", chain]);
            }
        }

        args.AddRange(["-map", complexOut ?? "0:v:0"]);
        if (d.AudioStreamIndex is { } audioIdx && d.Audio != StreamAction.None)
            args.AddRange(["-map", $"0:{audioIdx}"]);

        args.AddRange(["-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn"]);

        if (transcodeVideo)
        {
            args.AddRange(VideoEncoderArgs(d, attempt!, video, spec.SegmentSeconds));
        }
        else
        {
            args.AddRange(["-c:v", "copy"]);
            if (spec.StartSeconds > 0.05)
            {
                // A generation that starts mid-file begins at a keyframe that may be an open-GOP CRA:
                // its leading (RASL) frames are displayed *before* it and reference the previous GOP.
                // Browsers map them to negative time, MSE drops them and then everything up to the
                // next keyframe. Drop just those leading packets (pts earlier than the first packet).
                args.AddRange(["-bsf:v", "noise=drop=lt(pts\\,startpts)"]);
            }
            if (PlaybackDecider.NormalizeVideo(video.Codec) == "hevc") args.AddRange(["-tag:v", "hvc1"]);
        }

        switch (d.Audio)
        {
            case StreamAction.Copy:
                args.AddRange(["-c:a", "copy"]);
                break;
            case StreamAction.Transcode:
                args.AddRange(["-c:a", "aac", "-b:a", $"{d.AudioKbps}k", "-ac", d.AudioChannels.ToString(CultureInfo.InvariantCulture)]);
                break;
            default:
                args.Add("-an");
                break;
        }

        args.AddRange([
            "-max_muxing_queue_size", "4096",
            "-f", "hls",
            "-hls_time", spec.SegmentSeconds.ToString(CultureInfo.InvariantCulture),
            "-hls_list_size", "0",
            "-hls_playlist_type", "event",
            "-hls_segment_type", "fmp4",
            "-hls_fmp4_init_filename", InitName,
            "-hls_flags", "independent_segments+temp_file",
            // Keep absolute decode times in every fragment. Without this the fMP4 muxer rebases each
            // track to zero independently, which shifts audio against video after a copy-mode seek.
            "-hls_segment_options", "movflags=+frag_discont",
            "-start_number", "0",
            // Relative names: FFmpeg runs with the generation directory as its working directory.
            // (On Windows a bare -hls_fmp4_init_filename is resolved against the CWD, not the playlist.)
            "-hls_segment_filename", SegmentPattern,
            PlaylistName,
        ]);
        return args;
    }

    public static string VideoFilterChain(PlaybackDecision d, PipelineAttempt attempt, VideoStreamInfo v, bool gpuFrames)
    {
        if (gpuFrames)
            return $"scale_cuda=w={d.OutputWidth}:h={d.OutputHeight}:format=nv12";
        return attempt.Tonemap switch
        {
            TonemapMethod.Libplacebo => $"{TonemapLibplacebo(d.OutputWidth, d.OutputHeight)}{Upload(attempt)}",
            TonemapMethod.Cpu => $"{TonemapCpu(d.OutputWidth, d.OutputHeight)},format={SoftwarePixFmt(attempt.Encoder)}{Upload(attempt)}",
            _ => $"scale={d.OutputWidth}:{d.OutputHeight}:flags=bicubic,format={SoftwarePixFmt(attempt.Encoder)}{Upload(attempt)}",
        };
    }

    /// <summary>VAAPI encoders only accept VAAPI surfaces: upload the CPU-scaled NV12 frames.</summary>
    private static string Upload(PipelineAttempt attempt) => attempt.Backend == "vaapi" ? ",hwupload" : "";

    /// <summary>GPU tone mapping via Vulkan (frames uploaded, mapped to BT.709 SDR, downloaded as NV12).</summary>
    public static string TonemapLibplacebo(int w, int h) =>
        $"hwupload,libplacebo=w={w}:h={h}:tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:" +
        "color_trc=bt709:range=tv:format=nv12,hwdownload,format=nv12";

    /// <summary>CPU tone mapping (zscale + Hable). Scales first so the float pipeline runs at output size.</summary>
    public static string TonemapCpu(int w, int h) =>
        $"zscale=w={w}:h={h}:filter=bicubic,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709," +
        "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv";

    /// <summary>NV12 for every hardware encoder, yuv420p for x264.</summary>
    private static string SoftwarePixFmt(string encoder) => HwBackends.IsHardwareEncoder(encoder) ? "nv12" : "yuv420p";

    public static List<string> VideoEncoderArgs(PlaybackDecision d, PipelineAttempt attempt, VideoStreamInfo v, int segmentSeconds)
    {
        var fps = v.FrameRate is > 1 and < 240 ? v.FrameRate.Value : 24.0;
        var gop = Math.Max(1, (int)Math.Round(fps * segmentSeconds));
        var kbps = d.TargetVideoKbps ?? 8000;
        var args = new List<string>();

        var hevc = attempt.Encoder.StartsWith("hevc_", StringComparison.Ordinal);
        string[] Rate() => ["-b:v", $"{kbps}k", "-maxrate", $"{(int)(kbps * 1.5)}k", "-bufsize", $"{kbps * 2}k"];
        string Profile() => hevc ? "main" : "high";
        switch (attempt.Backend)
        {
            case "nvenc":
                args.AddRange([
                    "-c:v", attempt.Encoder,
                    "-preset", "p4", "-tune", "hq",
                    "-rc", "vbr", "-cq", hevc ? "25" : "23",
                    .. Rate(),
                    "-spatial-aq", "1",
                    "-profile:v", Profile(),
                ]);
                args.AddRange(attempt.EncoderDeviceArgs);
                break;
            case "qsv":
                args.AddRange(["-c:v", attempt.Encoder, "-preset", "medium", "-look_ahead", "0", .. Rate(), "-profile:v", Profile()]);
                break;
            case "amf":
                args.AddRange(["-c:v", attempt.Encoder, "-quality", "balanced", "-rc", "vbr_peak", .. Rate(), "-profile:v", Profile()]);
                break;
            case "vaapi":
                args.AddRange(["-c:v", attempt.Encoder, "-rc_mode", "VBR", .. Rate(), "-profile:v", Profile()]);
                break;
            case "videotoolbox":
                args.AddRange(["-c:v", attempt.Encoder, "-allow_sw", "0", "-realtime", "1", .. Rate(), "-profile:v", Profile()]);
                break;
            default:
                args.AddRange([
                    "-c:v", "libx264",
                    "-preset", "veryfast",
                    "-crf", "21",
                    "-maxrate", $"{(int)(kbps * 1.5)}k", "-bufsize", $"{kbps * 2}k",
                    "-profile:v", "high",
                    "-sc_threshold", "0",
                ]);
                break;
        }
        if (hevc && attempt.HardwareEncode) args.AddRange(["-tag:v", "hvc1"]);

        args.AddRange([
            "-g", gop.ToString(CultureInfo.InvariantCulture),
            "-keyint_min", gop.ToString(CultureInfo.InvariantCulture),
            "-force_key_frames", $"expr:gte(t,n_forced*{segmentSeconds})",
        ]);
        // No -color_primaries/-color_trc/-colorspace here: FFmpeg 8 negotiates them inside the filter
        // graph and inserts a CPU format conversion that cannot accept CUDA frames. Tone-mapping
        // filters already tag their output as BT.709, which the encoder writes into the VUI.
        return args;
    }

    /// <summary>WebVTT extraction for a text subtitle stream (sidecar, source timeline).</summary>
    public static List<string> BuildSubtitleExtract(string input, bool isRemote, int streamIndex, double startSeconds, string outputFile)
    {
        var args = new List<string> { "-hide_banner", "-nostdin", "-y", "-loglevel", "error" };
        args.AddRange(InputArgs(isRemote));
        if (startSeconds > 1) args.AddRange(["-ss", Num(startSeconds)]);
        args.AddRange(["-copyts", "-i", input, "-map", $"0:{streamIndex}", "-c:s", "webvtt", "-flush_packets", "1", "-f", "webvtt", outputFile]);
        return args;
    }

    private static string Num(double v) => v.ToString("0.###", CultureInfo.InvariantCulture);
}
