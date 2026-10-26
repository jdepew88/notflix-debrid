using System.Globalization;
using System.Text.Json;

namespace Notflix.MediaEngine.Media;

public sealed class VideoStreamInfo
{
    public int Index { get; init; }
    public string Codec { get; init; } = "unknown";
    public string? Profile { get; init; }
    public int? Level { get; init; }
    public int Width { get; init; }
    public int Height { get; init; }
    public string? PixelFormat { get; init; }
    public int BitDepth { get; init; } = 8;
    public double? FrameRate { get; init; }
    public long? BitRate { get; init; }
    public string? ColorTransfer { get; init; }
    public string? ColorPrimaries { get; init; }
    public string? ColorSpace { get; init; }
    /// <summary>"SDR", "HDR10", "HLG", "Dolby Vision", "Dolby Vision (HDR10 base)".</summary>
    public string DynamicRange { get; init; } = "SDR";
    public int? DolbyVisionProfile { get; init; }
    public bool IsHdr => DynamicRange != "SDR";
}

public sealed class AudioStreamInfo
{
    public int Index { get; init; }
    public string Codec { get; init; } = "unknown";
    public string? Profile { get; init; }
    public int Channels { get; init; }
    public string? ChannelLayout { get; init; }
    public int? SampleRate { get; init; }
    public long? BitRate { get; init; }
    public string? Language { get; init; }
    public string? Title { get; init; }
    public bool Default { get; init; }
}

public sealed class SubtitleStreamInfo
{
    public int Index { get; init; }
    public string Codec { get; init; } = "unknown";
    public string? Language { get; init; }
    public string? Title { get; init; }
    public bool Default { get; init; }
    public bool Forced { get; init; }
    public bool IsText => MediaProbe.TextSubtitleCodecs.Contains(Codec);
    public bool IsImage => MediaProbe.ImageSubtitleCodecs.Contains(Codec);
}

public sealed class MediaProbe
{
    public static readonly HashSet<string> TextSubtitleCodecs =
        ["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "microdvd", "subviewer", "jacosub"];
    public static readonly HashSet<string> ImageSubtitleCodecs =
        ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"];

    public string FormatName { get; init; } = "unknown";
    public string? FormatLongName { get; init; }
    public double? Duration { get; init; }
    public double StartTime { get; init; }
    public long? BitRate { get; init; }
    public long? Size { get; init; }
    public VideoStreamInfo? Video { get; init; }
    public List<AudioStreamInfo> Audio { get; init; } = [];
    public List<SubtitleStreamInfo> Subtitles { get; init; } = [];

    /// <summary>Normalized container family: mp4, webm, matroska, mpegts, avi, other.</summary>
    public string Container
    {
        get
        {
            var f = FormatName.ToLowerInvariant();
            if (f.Contains("mp4") || f.Contains("mov") || f.Contains("m4a") || f.Contains("3gp")) return "mp4";
            if (f == "matroska,webm")
            {
                // ffprobe reports both names; decide by codecs (webm only carries VP8/VP9/AV1 + Vorbis/Opus).
                var webmVideo = Video?.Codec is "vp8" or "vp9" or "av1";
                var webmAudio = Audio.All(a => a.Codec is "opus" or "vorbis");
                return webmVideo && webmAudio && Subtitles.All(s => s.Codec == "webvtt") ? "webm" : "matroska";
            }
            if (f.Contains("webm")) return "webm";
            if (f.Contains("matroska")) return "matroska";
            if (f.Contains("mpegts") || f.Contains("m2ts")) return "mpegts";
            if (f.Contains("avi")) return "avi";
            return f;
        }
    }

    public static MediaProbe Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var format = root.TryGetProperty("format", out var f) ? f : default;

        VideoStreamInfo? video = null;
        var audio = new List<AudioStreamInfo>();
        var subs = new List<SubtitleStreamInfo>();

        if (root.TryGetProperty("streams", out var streams))
        {
            foreach (var s in streams.EnumerateArray())
            {
                var type = Str(s, "codec_type");
                var disposition = s.TryGetProperty("disposition", out var d) ? d : default;
                var tags = s.TryGetProperty("tags", out var t) ? t : default;
                if (type == "video" && video is null && Int(disposition, "attached_pic") != 1)
                {
                    video = ParseVideo(s);
                }
                else if (type == "audio")
                {
                    audio.Add(new AudioStreamInfo
                    {
                        Index = Int(s, "index") ?? 0,
                        Codec = Str(s, "codec_name") ?? "unknown",
                        Profile = Str(s, "profile"),
                        Channels = Int(s, "channels") ?? 2,
                        ChannelLayout = Str(s, "channel_layout"),
                        SampleRate = Int(s, "sample_rate"),
                        BitRate = Long(s, "bit_rate") ?? Long(tags, "BPS"),
                        Language = Str(tags, "language"),
                        Title = Str(tags, "title"),
                        Default = Int(disposition, "default") == 1,
                    });
                }
                else if (type == "subtitle")
                {
                    subs.Add(new SubtitleStreamInfo
                    {
                        Index = Int(s, "index") ?? 0,
                        Codec = Str(s, "codec_name") ?? "unknown",
                        Language = Str(tags, "language"),
                        Title = Str(tags, "title"),
                        Default = Int(disposition, "default") == 1,
                        Forced = Int(disposition, "forced") == 1,
                    });
                }
            }
        }

        return new MediaProbe
        {
            FormatName = Str(format, "format_name") ?? "unknown",
            FormatLongName = Str(format, "format_long_name"),
            Duration = Double(format, "duration"),
            StartTime = Double(format, "start_time") ?? 0,
            BitRate = Long(format, "bit_rate"),
            Size = Long(format, "size"),
            Video = video,
            Audio = audio,
            Subtitles = subs,
        };
    }

    private static VideoStreamInfo ParseVideo(JsonElement s)
    {
        var pixFmt = Str(s, "pix_fmt");
        var transfer = Str(s, "color_transfer");
        int? dvProfile = null;
        var hasDv = false;
        if (s.TryGetProperty("side_data_list", out var side))
        {
            foreach (var entry in side.EnumerateArray())
            {
                if ((Str(entry, "side_data_type") ?? "").Contains("DOVI", StringComparison.OrdinalIgnoreCase))
                {
                    hasDv = true;
                    dvProfile = Int(entry, "dv_profile");
                }
            }
        }
        var codecTag = Str(s, "codec_tag_string") ?? "";
        if (codecTag is "dvh1" or "dvhe") hasDv = true;

        var range = transfer switch
        {
            "smpte2084" => "HDR10",
            "arib-std-b67" => "HLG",
            _ => "SDR",
        };
        if (hasDv) range = range == "SDR" ? "Dolby Vision" : "Dolby Vision (HDR10 base)";

        var bitsRaw = Int(s, "bits_per_raw_sample");
        var bitDepth = bitsRaw is > 0 ? bitsRaw.Value : PixelFormatBitDepth(pixFmt);

        return new VideoStreamInfo
        {
            Index = Int(s, "index") ?? 0,
            Codec = Str(s, "codec_name") ?? "unknown",
            Profile = Str(s, "profile"),
            Level = Int(s, "level"),
            Width = Int(s, "width") ?? 0,
            Height = Int(s, "height") ?? 0,
            PixelFormat = pixFmt,
            BitDepth = bitDepth,
            FrameRate = ParseRate(Str(s, "avg_frame_rate")) ?? ParseRate(Str(s, "r_frame_rate")),
            BitRate = Long(s, "bit_rate") ?? (s.TryGetProperty("tags", out var tags) ? Long(tags, "BPS") : null),
            ColorTransfer = transfer,
            ColorPrimaries = Str(s, "color_primaries"),
            ColorSpace = Str(s, "color_space"),
            DynamicRange = range,
            DolbyVisionProfile = dvProfile,
        };
    }

    public static int PixelFormatBitDepth(string? pixFmt)
    {
        if (string.IsNullOrEmpty(pixFmt)) return 8;
        if (pixFmt.Contains("p010") || pixFmt.Contains("10le") || pixFmt.Contains("10be")) return 10;
        if (pixFmt.Contains("12le") || pixFmt.Contains("12be")) return 12;
        return 8;
    }

    private static double? ParseRate(string? rate)
    {
        if (string.IsNullOrEmpty(rate)) return null;
        var parts = rate.Split('/');
        if (parts.Length == 2 &&
            double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var n) &&
            double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && d > 0 && n > 0)
            return Math.Round(n / d, 3);
        return null;
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    private static int? Int(JsonElement e, string name)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return null;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i)) return i;
        if (v.ValueKind == JsonValueKind.String && int.TryParse(v.GetString(), out var j)) return j;
        return null;
    }

    private static long? Long(JsonElement e, string name)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return null;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var i)) return i;
        if (v.ValueKind == JsonValueKind.String && long.TryParse(v.GetString(), out var j)) return j;
        return null;
    }

    private static double? Double(JsonElement e, string name)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return null;
        if (v.ValueKind == JsonValueKind.Number) return v.GetDouble();
        if (v.ValueKind == JsonValueKind.String &&
            double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d)) return d;
        return null;
    }
}
