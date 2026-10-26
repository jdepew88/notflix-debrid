using Notflix.MediaEngine.Media;
using Notflix.MediaEngine.Playback;

namespace Notflix.MediaEngine.Tests;

public class PlaybackDeciderTests
{
    private static readonly EngineOptions Options = new();

    private static readonly HardwareCapabilities Rtx = new()
    {
        FfmpegAvailable = true,
        GpuName = "Example NVIDIA GPU",
        VerifiedEncoders = ["h264_nvenc", "hevc_nvenc", "av1_nvenc"],
        VerifiedHardwareDecoders = ["h264", "hevc", "av1", "vp9", "mpeg2video", "mpeg4"],
        ListedHardwareDecoders = ["h264", "hevc", "av1", "vp9", "mpeg2video", "mpeg4", "vc1", "vp8"],
        LibplaceboTonemap = true,
        CpuTonemap = true,
    };

    private static readonly HardwareCapabilities CpuOnly = new() { FfmpegAvailable = true, CpuTonemap = true };

    private static readonly ClientCapabilities Chrome = new()
    {
        DirectVideo = ["h264", "hevc", "av1", "vp9"],
        MseVideo = ["h264", "hevc", "av1", "vp9"],
        DirectAudio = ["aac", "mp3", "opus", "flac"],
        MseAudio = ["aac", "mp3", "opus", "flac"],
        TenBit = ["hevc", "av1", "vp9"],
    };

    private static readonly ClientCapabilities H264Only = ClientCapabilities.Conservative;

    private static MediaProbe Probe(string format, string vcodec, string acodec, int height = 1080, int bitDepth = 8,
        string? transfer = null, int audioTracks = 1, string pix = "yuv420p")
    {
        var audio = Enumerable.Range(0, audioTracks)
            .Select(i => new AudioStreamInfo { Index = i + 1, Codec = i == 0 ? acodec : "ac3", Channels = 6, Language = i == 0 ? "eng" : "spa" })
            .ToList();
        return new MediaProbe
        {
            FormatName = format,
            Duration = 3600,
            Video = new VideoStreamInfo
            {
                Index = 0, Codec = vcodec, Width = height * 16 / 9, Height = height, BitDepth = bitDepth, PixelFormat = pix,
                FrameRate = 23.976, ColorTransfer = transfer,
                DynamicRange = transfer == "smpte2084" ? "HDR10" : "SDR",
            },
            Audio = audio,
            Subtitles =
            [
                new SubtitleStreamInfo { Index = 10, Codec = "subrip", Language = "eng" },
                new SubtitleStreamInfo { Index = 11, Codec = "hdmv_pgs_subtitle", Language = "eng" },
            ],
        };
    }

    private static PlaybackDecision Decide(MediaProbe p, ClientCapabilities c, HardwareCapabilities? hw = null,
        PlaybackPreferences? prefs = null, int? audio = null, int? sub = null) =>
        PlaybackDecider.Decide(p, c, prefs ?? new PlaybackPreferences(), hw ?? Rtx, Options, audio, sub);

    [Fact]
    public void H264AacMp4_DirectPlays()
    {
        var d = Decide(Probe("mov,mp4,m4a,3gp,3g2,mj2", "h264", "aac"), Chrome);
        Assert.Equal(PlaybackMode.DirectPlay, d.Mode);
        Assert.Equal(StreamAction.Copy, d.Video);
    }

    [Fact]
    public void CompatibleCodecsInMkv_Remux()
    {
        var d = Decide(Probe("matroska,webm", "h264", "aac"), Chrome);
        Assert.Equal(PlaybackMode.Remux, d.Mode);
        Assert.Equal(StreamAction.Copy, d.Video);
        Assert.Equal(StreamAction.Copy, d.Audio);
    }

    [Theory]
    [InlineData("dts")]
    [InlineData("truehd")]
    [InlineData("ac3")]
    [InlineData("eac3")]
    public void UnsupportedAudio_TranscodesAudioOnly(string audio)
    {
        var d = Decide(Probe("matroska,webm", "h264", audio), Chrome);
        Assert.Equal(PlaybackMode.AudioTranscode, d.Mode);
        Assert.Equal(StreamAction.Copy, d.Video);
        Assert.Equal(StreamAction.Transcode, d.Audio);
        Assert.Equal("aac", d.OutputAudioCodec);
    }

    [Fact]
    public void UnsupportedAudioInMp4_NeverDirectPlays()
    {
        var d = Decide(Probe("mov,mp4,m4a,3gp,3g2,mj2", "h264", "ac3"), Chrome);
        Assert.Equal(PlaybackMode.AudioTranscode, d.Mode);
    }

    [Fact]
    public void HevcOnHevcBrowser_IsNotReencoded()
    {
        var d = Decide(Probe("matroska,webm", "hevc", "ac3", bitDepth: 10), Chrome);
        Assert.Equal(PlaybackMode.AudioTranscode, d.Mode);
        Assert.Equal(StreamAction.Copy, d.Video);
    }

    [Fact]
    public void HevcOnH264OnlyBrowser_UsesNvdecAndNvenc()
    {
        var d = Decide(Probe("matroska,webm", "hevc", "aac"), H264Only);
        Assert.Equal(PlaybackMode.VideoTranscode, d.Mode);
        Assert.Equal("NVDEC + NVENC H.264", d.Attempts[0].Label);
        Assert.True(d.Attempts[0].HardwareDecode);
        Assert.Equal("h264_nvenc", d.Attempts[0].Encoder);
        Assert.Equal("libx264", d.Attempts[^1].Encoder); // CPU is always the last rung
        Assert.Equal(StreamAction.Copy, d.Audio);         // AAC stays untouched
    }

    [Fact]
    public void NoGpu_FallsBackToCpuOnly()
    {
        var d = Decide(Probe("matroska,webm", "hevc", "aac"), H264Only, hw: CpuOnly);
        Assert.Single(d.Attempts);
        Assert.Equal("libx264", d.Attempts[0].Encoder);
    }

    [Fact]
    public void HardwareOff_PreferenceIsHonoured()
    {
        var d = Decide(Probe("avi", "mpeg4", "mp3"), Chrome, prefs: new PlaybackPreferences { HardwareAcceleration = "off" });
        Assert.All(d.Attempts, a => Assert.False(a.HardwareEncode));
    }

    [Fact]
    public void Hi10P_DecodesOnCpuButEncodesOnGpu()
    {
        var d = Decide(Probe("matroska,webm", "h264", "aac", bitDepth: 10, pix: "yuv420p10le"), Chrome);
        Assert.Equal(PlaybackMode.VideoTranscode, d.Mode);
        Assert.False(d.Attempts[0].HardwareDecode);
        Assert.Equal("h264_nvenc", d.Attempts[0].Encoder);
    }

    [Fact]
    public void Hdr4kOnH264Browser_TonemapsOnGpu()
    {
        var d = Decide(Probe("matroska,webm", "hevc", "eac3", height: 2160, bitDepth: 10, transfer: "smpte2084"), H264Only);
        Assert.Equal(PlaybackMode.VideoTranscode, d.Mode);
        Assert.Equal(TonemapMethod.Libplacebo, d.Attempts[0].Tonemap);
        Assert.Equal(TonemapMethod.Cpu, d.Attempts[^1].Tonemap);
        Assert.Equal(2160, d.OutputHeight);
    }

    [Fact]
    public void Hdr4kOnHevcBrowser_With4kOutput_PrefersHevcNvenc()
    {
        var client = new ClientCapabilities { DirectVideo = ["h264", "hevc"], MseVideo = ["h264", "hevc"], TenBit = [] };
        var d = Decide(Probe("matroska,webm", "hevc", "aac", height: 2160, bitDepth: 10, transfer: "smpte2084"), client);
        Assert.Equal(PlaybackMode.VideoTranscode, d.Mode); // 10-bit unsupported by this client
        Assert.Equal("hevc_nvenc", d.Attempts[0].Encoder);
        Assert.Equal("hevc", d.OutputVideoCodec);
    }

    [Fact]
    public void MaxResolutionPreference_ForcesDownscale()
    {
        var d = Decide(Probe("matroska,webm", "hevc", "aac", height: 2160), Chrome, prefs: new PlaybackPreferences { MaxHeight = 1080 });
        Assert.Equal(PlaybackMode.VideoTranscode, d.Mode);
        Assert.Equal(1080, d.OutputHeight);
        Assert.Equal(1920, d.OutputWidth);
    }

    [Fact]
    public void ImageSubtitles_ForceBurnIn()
    {
        var d = Decide(Probe("matroska,webm", "h264", "aac"), Chrome, sub: 11);
        Assert.Equal(PlaybackMode.VideoTranscode, d.Mode);
        Assert.Equal(11, d.BurnSubtitleIndex);
    }

    [Fact]
    public void TextSubtitles_DoNotForceTranscode()
    {
        var d = Decide(Probe("mov,mp4,m4a,3gp,3g2,mj2", "h264", "aac"), Chrome, sub: 10);
        Assert.Equal(PlaybackMode.DirectPlay, d.Mode);
    }

    [Fact]
    public void NonDefaultAudioTrack_SwitchesDirectPlayToRemux()
    {
        var probe = Probe("mov,mp4,m4a,3gp,3g2,mj2", "h264", "aac", audioTracks: 2);
        probe.Audio[1] = new AudioStreamInfo { Index = 2, Codec = "aac", Channels = 2, Language = "spa" };
        var d = Decide(probe, Chrome, audio: 2);
        Assert.Equal(PlaybackMode.Remux, d.Mode);
        Assert.Equal(2, d.AudioStreamIndex);
    }

    [Fact]
    public void AudioSelection_PrefersLanguageAndSkipsCommentary()
    {
        var probe = new MediaProbe
        {
            FormatName = "matroska,webm",
            Video = new VideoStreamInfo { Codec = "h264", Width = 1920, Height = 1080 },
            Audio =
            [
                new AudioStreamInfo { Index = 1, Codec = "aac", Language = "fre", Default = true },
                new AudioStreamInfo { Index = 2, Codec = "aac", Language = "eng", Title = "Director's Commentary" },
                new AudioStreamInfo { Index = 3, Codec = "dts", Language = "eng" },
            ],
        };
        Assert.Equal(3, PlaybackDecider.SelectAudio(probe, null, "en")!.Index);
        Assert.Equal(1, PlaybackDecider.SelectAudio(probe, 1, "en")!.Index);
    }

    [Fact]
    public void ForceMode_Remux_SkipsDirectPlay()
    {
        var d = Decide(Probe("mov,mp4,m4a,3gp,3g2,mj2", "h264", "aac"), Chrome, prefs: new PlaybackPreferences { ForceMode = "remux" });
        Assert.Equal(PlaybackMode.Remux, d.Mode);
    }

    [Fact]
    public void WebmContainerDetection_RequiresWebmCodecs()
    {
        var webm = new MediaProbe
        {
            FormatName = "matroska,webm",
            Video = new VideoStreamInfo { Codec = "vp9", Width = 1280, Height = 720 },
            Audio = [new AudioStreamInfo { Index = 1, Codec = "opus" }],
        };
        Assert.Equal("webm", webm.Container);
        // SRT/PGS subtitles or H.264 cannot live in WebM, so these are Matroska.
        Assert.Equal("matroska", Probe("matroska,webm", "vp9", "opus").Container);
        Assert.Equal("matroska", Probe("matroska,webm", "h264", "aac").Container);
    }
}
