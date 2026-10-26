namespace Notflix.MediaEngine.Media;

/// <summary>Static facts about the hardware video backends the engine knows how to drive.</summary>
public static class HwBackends
{
    /// <summary>Encode backends in auto-selection priority order.</summary>
    public static readonly string[] Priority = ["nvenc", "qsv", "amf", "vaapi", "videotoolbox"];

    /// <summary>Values accepted for hardwareAcceleration (config, /config, per-session preference).</summary>
    public static readonly string[] RequestValues = ["auto", "nvenc", "qsv", "amf", "vaapi", "videotoolbox", "off"];

    public static readonly string[] EncodeCodecs = ["h264", "hevc", "av1"];
    public static readonly string[] DecodeCodecs = ["h264", "hevc", "av1", "vp9", "mpeg2video", "mpeg4"];

    public static bool IsBackend(string? id) => id is not null && Priority.Contains(id);

    public static string Label(string id) => id switch
    {
        "nvenc" => "NVIDIA NVENC / NVDEC",
        "qsv" => "Intel Quick Sync Video",
        "amf" => "AMD AMF",
        "vaapi" => "VA-API",
        "videotoolbox" => "Apple VideoToolbox",
        "d3d11va" => "Direct3D 11 video decode",
        "software" => "Software (CPU)",
        _ => id,
    };

    /// <summary>Short name used in pipeline labels ("CPU decode + AMF H.264").</summary>
    public static string ShortName(string id) => id switch
    {
        "nvenc" => "NVENC",
        "qsv" => "QSV",
        "amf" => "AMF",
        "vaapi" => "VAAPI",
        "videotoolbox" => "VideoToolbox",
        "software" => "x264",
        _ => id.ToUpperInvariant(),
    };

    public static string Vendor(string id) => id switch
    {
        "nvenc" => "nvidia",
        "qsv" => "intel",
        "amf" => "amd",
        "videotoolbox" => "apple",
        _ => "other",
    };

    public static string? PciVendorFor(string id) => id switch
    {
        "nvenc" => "10de",
        "qsv" => "8086",
        "amf" => "1002",
        _ => null,
    };

    public static string EncoderName(string backend, string codec) => $"{codec}_{backend}";

    /// <summary>Backend id of an FFmpeg encoder name ("h264_amf" → "amf"), "software" otherwise.</summary>
    public static string BackendOfEncoder(string encoder)
    {
        foreach (var b in Priority)
            if (encoder.EndsWith("_" + b, StringComparison.Ordinal)) return b;
        return "software";
    }

    public static bool IsHardwareEncoder(string encoder) => BackendOfEncoder(encoder) != "software";

    /// <summary>OS gate: backends that cannot exist on an OS are "unsupported" without running anything.</summary>
    public static bool SupportedOn(string id, HostOs os) => id switch
    {
        "nvenc" or "qsv" or "amf" => os is HostOs.Windows or HostOs.Linux,
        "vaapi" => os == HostOs.Linux,
        "videotoolbox" => os == HostOs.MacOS,
        "d3d11va" => os == HostOs.Windows,
        _ => false,
    };
}

/// <summary>What one backend can do on this host, as reported by GET /capabilities.</summary>
public sealed record BackendReport
{
    public required string Id { get; init; }
    public required string Label { get; init; }
    public required string Vendor { get; init; }
    /// <summary>"encode+decode" or "decode".</summary>
    public required string Kind { get; init; }
    /// <summary>"verified" (a real test run succeeded), "detected" (listed/present but tests failed), "unsupported".</summary>
    public required string Status { get; init; }
    /// <summary>codec → "verified" | "failed" | "not-listed".</summary>
    public Dictionary<string, string> Encoders { get; init; } = [];
    /// <summary>codec → "verified" | "failed" | "not-listed" | "untested".</summary>
    public Dictionary<string, string> Decoders { get; init; } = [];
    public string? Device { get; init; }
    public List<string> Notes { get; init; } = [];
}

/// <summary>A verified way to decode on hardware that pairs with an encode backend.</summary>
public sealed record HwDecodePath
{
    /// <summary>"cuda", "d3d11va", "vaapi", "videotoolbox".</summary>
    public required string Hwaccel { get; init; }
    /// <summary>Pipeline label prefix: "NVDEC", "D3D11VA", "VAAPI", "VideoToolbox".</summary>
    public required string Label { get; init; }
    /// <summary>FFmpeg input options that enable it (frames are downloaded to system memory).</summary>
    public IReadOnlyList<string> InputArgs { get; init; } = [];
    public HashSet<string> Verified { get; init; } = [];
    public string? Adapter { get; init; }
}

/// <summary>Device options an encode backend needs in every pipeline using it.</summary>
public sealed record BackendDevice
{
    /// <summary>Global options before the input (e.g. VAAPI device + filter device).</summary>
    public IReadOnlyList<string> PreInputArgs { get; init; } = [];
    /// <summary>Encoder options (e.g. NVENC -gpu N).</summary>
    public IReadOnlyList<string> EncoderArgs { get; init; } = [];
    /// <summary>Extra options for the CUDA hwaccel (e.g. -hwaccel_device N).</summary>
    public IReadOnlyList<string> HwaccelArgs { get; init; } = [];
    public string? Description { get; init; }
}

public sealed record BackendSelection(string Requested, string Effective, string? Device, string? FallbackReason);

public static class BackendSelector
{
    public static string Normalize(string? requested)
    {
        var r = (requested ?? "").Trim().ToLowerInvariant();
        return HwBackends.RequestValues.Contains(r) ? r : "auto";
    }

    /// <summary>Backends whose H.264 encoder passed a real test encode, in priority order.</summary>
    public static IEnumerable<string> Verified(HardwareCapabilities hw) =>
        HwBackends.Priority.Where(b => hw.VerifiedEncoders.Contains(HwBackends.EncoderName(b, "h264")));

    /// <summary>
    /// auto → best verified backend (nvenc > qsv > amf > vaapi > videotoolbox) or software.
    /// A named backend that is not verified falls back to auto and says why.
    /// </summary>
    public static BackendSelection Select(HardwareCapabilities hw, string? requested, string? device)
    {
        var req = Normalize(requested);
        if (req == "off") return new BackendSelection(req, "software", null, null);
        var verified = Verified(hw).ToList();
        var auto = verified.FirstOrDefault() ?? "software";
        if (req == "auto") return new BackendSelection(req, auto, null, null);
        if (verified.Contains(req)) return new BackendSelection(req, req, string.IsNullOrWhiteSpace(device) ? null : device, null);
        var why = hw.Backends.FirstOrDefault(b => b.Id == req) is { } report && report.Notes.Count > 0 ? $" ({report.Notes[0]})" : "";
        var reason = $"{HwBackends.ShortName(req)} was requested but is not available on this host{why}; using " +
                     (auto == "software" ? "the CPU" : HwBackends.ShortName(auto));
        return new BackendSelection(req, auto, null, reason);
    }
}
