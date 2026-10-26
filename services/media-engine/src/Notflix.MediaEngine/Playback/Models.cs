namespace Notflix.MediaEngine.Playback;

/// <summary>What the viewer's browser reported it can decode (MediaSource / canPlayType probes).</summary>
public sealed class ClientCapabilities
{
    /// <summary>Codecs playable by a plain &lt;video src&gt; in an MP4/WebM file.</summary>
    public List<string> DirectVideo { get; set; } = ["h264"];
    public List<string> DirectAudio { get; set; } = ["aac", "mp3"];
    /// <summary>Codecs playable through MediaSource in fragmented MP4 (what HLS.js uses).</summary>
    public List<string> MseVideo { get; set; } = ["h264"];
    public List<string> MseAudio { get; set; } = ["aac", "mp3"];
    /// <summary>10-bit decode support per codec (hevc Main10, av1 Main 10-bit, vp9 profile 2).</summary>
    public List<string> TenBit { get; set; } = [];
    public bool HdrDisplay { get; set; }
    public bool Mse { get; set; } = true;
    public bool NativeHls { get; set; }
    public int? MaxHeight { get; set; }

    public static ClientCapabilities Conservative => new();
}

/// <summary>User preferences that influence the plan (from Notflix settings).</summary>
public sealed class PlaybackPreferences
{
    public int MaxHeight { get; set; } = 2160;
    public int? MaxBitrateKbps { get; set; }
    /// <summary>"best", "balanced", "data-saver".</summary>
    public string Quality { get; set; } = "best";
    /// <summary>"auto", "nvenc", "qsv", "amf", "vaapi", "videotoolbox", "off". "auto" follows the engine setting.</summary>
    public string HardwareAcceleration { get; set; } = "auto";
    public bool AllowDirectPlay { get; set; } = true;
    public bool Surround { get; set; }
    public string AudioLanguage { get; set; } = "en";
    /// <summary>Ordered audio language preferences (two-letter codes); overrides AudioLanguage when set.</summary>
    public List<string> AudioLanguages { get; set; } = [];
    /// <summary>The title's original language (from metadata), used when PreferOriginalAudio is on.</summary>
    public string? OriginalLanguage { get; set; }
    public bool PreferOriginalAudio { get; set; }

    public IEnumerable<string> OrderedAudioLanguages()
    {
        var list = new List<string>();
        if (PreferOriginalAudio && !string.IsNullOrWhiteSpace(OriginalLanguage)) list.Add(OriginalLanguage!);
        list.AddRange(AudioLanguages.Count > 0 ? AudioLanguages : [AudioLanguage]);
        return list.Where(l => !string.IsNullOrWhiteSpace(l)).Select(l => l.Trim().ToLowerInvariant()).Distinct();
    }
    /// <summary>Force a mode for testing/troubleshooting: null, "remux", "audio", "video".</summary>
    public string? ForceMode { get; set; }
}

public enum PlaybackMode { DirectPlay, Remux, AudioTranscode, VideoTranscode }

public enum StreamAction { Copy, Transcode, None }

public enum TonemapMethod { None, Libplacebo, Cpu }

/// <summary>One rung of the fallback ladder for video transcodes.</summary>
public sealed record PipelineAttempt(string Label, bool HardwareDecode, string Encoder, TonemapMethod Tonemap)
{
    /// <summary>Encode backend id ("nvenc", "qsv", "amf", "vaapi", "videotoolbox") or "software".</summary>
    public string Backend => Media.HwBackends.BackendOfEncoder(Encoder);
    public bool HardwareEncode => Backend != "software";

    /// <summary>
    /// Hardware decoder used when <see cref="HardwareDecode"/> is set: "cuda" (default, NVDEC with the
    /// full-GPU scale_cuda path), "d3d11va", "vaapi" or "videotoolbox" (frames downloaded to system memory).
    /// </summary>
    public string? Hwaccel { get; init; }
    public string DecodeHwaccel => HardwareDecode ? Hwaccel ?? "cuda" : "none";

    /// <summary>Input options enabling the hardware decoder (null: plain "-hwaccel cuda").</summary>
    public IReadOnlyList<string>? DecodeArgs { get; init; }
    /// <summary>Global options the encoder's device needs before the input (VAAPI device + filter device).</summary>
    public IReadOnlyList<string> DeviceArgs { get; init; } = [];
    /// <summary>Extra encoder options (NVENC -gpu N).</summary>
    public IReadOnlyList<string> EncoderDeviceArgs { get; init; } = [];
}

public sealed class PlaybackDecision
{
    public PlaybackMode Mode { get; init; }
    public StreamAction Video { get; init; }
    public StreamAction Audio { get; init; }
    public int? AudioStreamIndex { get; init; }
    /// <summary>Two-letter language of the selected audio track, or null when the track is untagged.</summary>
    public string? SelectedAudioLanguage { get; init; }
    /// <summary>Whether the selected track is in a preferred language (null: no preference or untagged).</summary>
    public bool? AudioLanguageMatched { get; init; }
    /// <summary>Languages (two-letter) carried by this file's audio tracks.</summary>
    public List<string> AvailableAudioLanguages { get; init; } = [];
    /// <summary>Image subtitle stream burned into the picture (forces a video transcode).</summary>
    public int? BurnSubtitleIndex { get; init; }
    public string OutputVideoCodec { get; init; } = "copy";
    public string OutputAudioCodec { get; init; } = "copy";
    public int OutputWidth { get; init; }
    public int OutputHeight { get; init; }
    public int? TargetVideoKbps { get; init; }
    public int AudioChannels { get; init; } = 2;
    public int AudioKbps { get; init; } = 192;
    public List<PipelineAttempt> Attempts { get; init; } = [];
    public List<string> Reasons { get; init; } = [];

    public string ModeLabel => Mode switch
    {
        PlaybackMode.DirectPlay => "Direct Play",
        PlaybackMode.Remux => "Remux",
        PlaybackMode.AudioTranscode => "Audio Transcode",
        _ => "Video Transcode",
    };
}
