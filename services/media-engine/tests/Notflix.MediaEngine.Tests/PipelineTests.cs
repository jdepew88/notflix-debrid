using System.Buffers.Binary;
using System.Net;
using System.Text;
using Notflix.MediaEngine.Media;
using Notflix.MediaEngine.Playback;
using Notflix.MediaEngine.Security;

namespace Notflix.MediaEngine.Tests;

public class FfmpegArgsBuilderTests
{
    private static MediaProbe HevcProbe(bool hdr = false) => new()
    {
        FormatName = "matroska,webm",
        Video = new VideoStreamInfo
        {
            Codec = "hevc", Width = 3840, Height = 2160, BitDepth = hdr ? 10 : 8, FrameRate = 24,
            ColorTransfer = hdr ? "smpte2084" : null, DynamicRange = hdr ? "HDR10" : "SDR",
        },
        Audio = [new AudioStreamInfo { Index = 1, Codec = "truehd", Channels = 8 }],
    };

    private static List<string> Build(PlaybackDecision d, PipelineAttempt? attempt, double start = 0) =>
        FfmpegArgsBuilder.BuildHls(new HlsJobSpec("https://example.real-debrid.com/x.mkv", true, HevcProbe(attempt?.Tonemap != TonemapMethod.None && attempt is not null), d, attempt, start, @"C:\tmp\g1", 4));

    [Fact]
    public void Remux_CopiesBothStreams_AndTagsHevc()
    {
        var d = new PlaybackDecision { Mode = PlaybackMode.Remux, Video = StreamAction.Copy, Audio = StreamAction.Copy, AudioStreamIndex = 1 };
        var args = Build(d, null);
        Assert.Contains("copy", args);
        Assert.Equal("hvc1", args[args.IndexOf("-tag:v") + 1]);
        Assert.Equal("copy", args[args.IndexOf("-c:a") + 1]);
        Assert.DoesNotContain("-hwaccel", args);
        Assert.Contains("-reconnect", args);
        Assert.Contains("movflags=+frag_discont", args);
        Assert.Equal("fmp4", args[args.IndexOf("-hls_segment_type") + 1]);
    }

    [Fact]
    public void AudioTranscode_NeverTouchesVideo()
    {
        var d = new PlaybackDecision { Mode = PlaybackMode.AudioTranscode, Video = StreamAction.Copy, Audio = StreamAction.Transcode, AudioStreamIndex = 1, AudioChannels = 2, AudioKbps = 192 };
        var args = Build(d, null);
        Assert.Equal("copy", args[args.IndexOf("-c:v") + 1]);
        Assert.Equal("aac", args[args.IndexOf("-c:a") + 1]);
        Assert.Equal("2", args[args.IndexOf("-ac") + 1]);
        Assert.DoesNotContain("-vf", args);
    }

    [Fact]
    public void CopySeek_StartsAudioAtTheVideoKeyframe()
    {
        var d = new PlaybackDecision { Mode = PlaybackMode.AudioTranscode, Video = StreamAction.Copy, Audio = StreamAction.Transcode, AudioStreamIndex = 1 };
        var args = Build(d, null, start: 2898.2);
        Assert.True(args.IndexOf("-noaccurate_seek") >= 0 && args.IndexOf("-noaccurate_seek") < args.IndexOf("-ss"));
        var transcode = new PipelineAttempt("CPU decode + x264", false, "libx264", TonemapMethod.None);
        var v = new PlaybackDecision { Mode = PlaybackMode.VideoTranscode, Video = StreamAction.Transcode, Audio = StreamAction.Transcode, AudioStreamIndex = 1, OutputWidth = 1280, OutputHeight = 720, Attempts = [transcode] };
        Assert.DoesNotContain("-noaccurate_seek", Build(v, transcode, start: 2898.2)); // both tracks re-encoded: exact seek
        // Leading (open-GOP RASL) frames before the first keyframe are dropped on mid-file copies only.
        Assert.Equal(@"noise=drop=lt(pts\,startpts)", args[args.IndexOf("-bsf:v") + 1]);
        Assert.DoesNotContain("-bsf:v", Build(d, null, start: 0));
    }

    [Fact]
    public void NvdecNvenc_KeepsFramesOnGpu()
    {
        var attempt = new PipelineAttempt("NVDEC + NVENC H.264", true, "h264_nvenc", TonemapMethod.None);
        var d = new PlaybackDecision
        {
            Mode = PlaybackMode.VideoTranscode, Video = StreamAction.Transcode, Audio = StreamAction.Transcode,
            AudioStreamIndex = 1, OutputWidth = 1920, OutputHeight = 1080, TargetVideoKbps = 8000, Attempts = [attempt],
        };
        var args = Build(d, attempt, start: 120);
        Assert.Equal("cuda", args[args.IndexOf("-hwaccel") + 1]);
        Assert.Equal("cuda", args[args.IndexOf("-hwaccel_output_format") + 1]);
        Assert.DoesNotContain("-extra_hw_frames", args); // exceeds the NVDEC surface pool for HEVC
        Assert.DoesNotContain("-color_trc", args);       // forces a CPU conversion of CUDA frames
        Assert.StartsWith("scale_cuda=w=1920:h=1080", args[args.IndexOf("-vf") + 1]);
        Assert.Equal("h264_nvenc", args[args.IndexOf("-c:v") + 1]);
        Assert.True(args.IndexOf("-ss") < args.IndexOf("-i"), "-ss must be an input option (fast seek)");
        Assert.Equal("120", args[args.IndexOf("-ss") + 1]);
        Assert.Equal("96", args[args.IndexOf("-g") + 1]);
    }

    [Fact]
    public void HdrTonemap_UsesVulkanLibplacebo()
    {
        var attempt = new PipelineAttempt("NVDEC + NVENC H.264", true, "h264_nvenc", TonemapMethod.Libplacebo);
        var d = new PlaybackDecision
        {
            Mode = PlaybackMode.VideoTranscode, Video = StreamAction.Transcode, Audio = StreamAction.Transcode,
            AudioStreamIndex = 1, OutputWidth = 1920, OutputHeight = 1080, Attempts = [attempt],
        };
        var args = Build(d, attempt);
        Assert.Equal("vulkan=vk", args[args.IndexOf("-init_hw_device") + 1]);
        Assert.DoesNotContain("-hwaccel_output_format", args); // frames go through system memory to Vulkan
        Assert.Contains("libplacebo", args[args.IndexOf("-vf") + 1]);
        Assert.Contains("tonemapping=bt.2390", args[args.IndexOf("-vf") + 1]);
    }

    [Fact]
    public void ImageSubtitleBurnIn_UsesOverlayGraph()
    {
        var attempt = new PipelineAttempt("NVDEC + NVENC H.264", true, "h264_nvenc", TonemapMethod.None);
        var d = new PlaybackDecision
        {
            Mode = PlaybackMode.VideoTranscode, Video = StreamAction.Transcode, Audio = StreamAction.Copy,
            AudioStreamIndex = 1, BurnSubtitleIndex = 5, OutputWidth = 1920, OutputHeight = 1080, Attempts = [attempt],
        };
        var args = Build(d, attempt);
        var graph = args[args.IndexOf("-filter_complex") + 1];
        Assert.Contains("[0:5]overlay", graph);
        Assert.Equal("[vout]", args[args.IndexOf("-map") + 1]);
        Assert.DoesNotContain("-hwaccel_output_format", args);
    }

    [Fact]
    public void Software_UsesX264()
    {
        var attempt = new PipelineAttempt("CPU decode + x264", false, "libx264", TonemapMethod.None);
        var d = new PlaybackDecision
        {
            Mode = PlaybackMode.VideoTranscode, Video = StreamAction.Transcode, Audio = StreamAction.Transcode,
            AudioStreamIndex = 1, OutputWidth = 1280, OutputHeight = 720, Attempts = [attempt],
        };
        var args = Build(d, attempt);
        Assert.DoesNotContain("-hwaccel", args);
        Assert.Equal("libx264", args[args.IndexOf("-c:v") + 1]);
        Assert.Contains("format=yuv420p", args[args.IndexOf("-vf") + 1]);
    }
}

public class PlaylistAndProgressTests
{
    [Fact]
    public void ParsesSegmentsWithAccumulatedStart()
    {
        var (segs, ended) = TranscodeJob.ParsePlaylist(
            "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.004,\nseg_00000.m4s\n#EXTINF:3.5,\nseg_00001.m4s\n#EXTINF:4,\nseg_00002.m4s\n#EXT-X-ENDLIST\n");
        Assert.True(ended);
        Assert.Equal(3, segs.Count);
        Assert.Equal(1, segs[1].Index); // the "4" in ".m4s" must not leak into the index
        Assert.Equal(7.504, segs[2].Start, 3);
    }

    [Fact]
    public void ParsesFfmpegProgress()
    {
        var p = TranscodeJob.ParseProgress(new Dictionary<string, string>
        {
            ["frame"] = "480", ["fps"] = "406.65", ["bitrate"] = "6123.4kbits/s", ["out_time_us"] = "20000000",
            ["drop_frames"] = "2", ["dup_frames"] = "1", ["speed"] = "17.3x",
        });
        Assert.Equal(480, p.Frame);
        Assert.Equal(6123.4, p.BitrateKbps);
        Assert.Equal(20, p.OutTimeSeconds);
        Assert.Equal(17.3, p.Speed);
        Assert.Equal(2, p.DropFrames);
    }

    [Theory]
    [InlineData("[hevc] cuvidCreateDecoder failed -> CUDA_ERROR_INVALID_VALUE", "hardware")]
    [InlineData("OpenEncodeSessionEx failed: out of memory", "hardware")]
    [InlineData("HTTP error 503 Service Unavailable", "source")]
    [InlineData("Invalid data found when processing input", "decode")]
    [InlineData("[h264_qsv @ 0x55] Error initializing an internal MFX session: unsupported (-3)", "hardware")]
    [InlineData("[h264_amf @ 0000] AMF failed to initialise on the given D3D11 device: 1.", "hardware")]
    [InlineData("[AVHWDeviceContext @ 0x5] Failed to initialise VAAPI connection: -1 (unknown libva error).", "hardware")]
    [InlineData("[h264_videotoolbox @ 0x7f] Error: cannot create compression session: -12902", "hardware")]
    [InlineData("[D3D11VA @ 000001] Failed to find d3d11va adapter by vendor id 0x8086", "hardware")]
    public void ClassifiesFailures(string stderr, string expected) =>
        Assert.Equal(expected, TranscodeJob.ClassifyFailure(stderr));

    [Fact]
    public void RedactsSignedUrls()
    {
        var text = MediaProber.Redact("Error opening https://lax5-4.download.real-debrid.com/d/SECRETCODE123/Movie.2024.mkv?token=abc");
        Assert.DoesNotContain("SECRETCODE123", text);
        Assert.DoesNotContain("token=abc", text);
        Assert.Contains("Movie.2024.mkv", text);
    }
}

public class Fmp4InspectorTests
{
    private static byte[] Box(string type, params byte[][] children)
    {
        var payload = children.SelectMany(c => c).ToArray();
        var buf = new byte[8 + payload.Length];
        BinaryPrimitives.WriteUInt32BigEndian(buf, (uint)buf.Length);
        Encoding.ASCII.GetBytes(type).CopyTo(buf, 4);
        payload.CopyTo(buf, 8);
        return buf;
    }

    private static byte[] Full(int version, params int[] fields)
    {
        var buf = new List<byte> { (byte)version, 0, 0, 0 };
        foreach (var f in fields)
        {
            var b = new byte[4];
            BinaryPrimitives.WriteUInt32BigEndian(b, (uint)f);
            buf.AddRange(b);
        }
        return buf.ToArray();
    }

    [Fact]
    public void ReadsEarliestDecodeTimeAcrossTracks()
    {
        // tkhd v0: version/flags, creation, modification, track_ID ; mdhd v0: version/flags, creation, modification, timescale
        var init = Box("moov",
            Box("trak", Box("tkhd", Full(0, 0, 0, 1)), Box("mdia", Box("mdhd", Full(0, 0, 0, 16000)))),
            Box("trak", Box("tkhd", Full(0, 0, 0, 2)), Box("mdia", Box("mdhd", Full(0, 0, 0, 48000)))));
        var seg = Box("moof",
            Box("traf", Box("tfhd", Full(0, 1)), Box("tfdt", Full(0, 4_800_000))),          // 300.0 s video
            Box("traf", Box("tfhd", Full(0, 2)), Box("tfdt", Full(0, 14_446_976))));        // 300.979 s audio
        var scales = Fmp4Inspector.ReadTimescales(init);
        Assert.Equal(16000u, scales[1]);
        Assert.Equal(300.0, Fmp4Inspector.EarliestDecodeTimeSeconds(Box("styp", new byte[4]).Concat(seg).ToArray(), scales)!.Value, 3);
    }
}

public class SecurityTests
{
    private static readonly byte[] Key = Encoding.UTF8.GetBytes("unit-test-secret-unit-test-secret-1234");

    private static TicketPayload Payload(int ttl = 60) => new()
    {
        Owner = "owner", Nonce = Guid.NewGuid().ToString("N"),
        ExpiresAtUnix = DateTimeOffset.UtcNow.AddSeconds(ttl).ToUnixTimeSeconds(),
        Source = new TicketSource { Kind = "url", Url = "https://x.download.real-debrid.com/d/A/file.mkv" },
    };

    [Fact]
    public void ValidTicket_IsAcceptedOnce()
    {
        var v = new TicketValidator(Key);
        var t = TicketValidator.Sign(Payload(), Key);
        Assert.Equal("owner", v.Validate(t).Owner);
        Assert.Throws<TicketException>(() => v.Validate(t));
    }

    [Fact]
    public void TamperedExpiredAndLongLivedTickets_AreRejected()
    {
        var v = new TicketValidator(Key);
        var t = TicketValidator.Sign(Payload(), Key);
        Assert.Throws<TicketException>(() => v.Validate(t[..^2] + "AA"));
        Assert.Throws<TicketException>(() => v.Validate(TicketValidator.Sign(Payload(-10), Key)));
        Assert.Throws<TicketException>(() => v.Validate(TicketValidator.Sign(Payload(3600), Key)));
        Assert.Throws<TicketException>(() => v.Validate(TicketValidator.Sign(Payload(), Encoding.UTF8.GetBytes("another-secret-another-secret-0000"))));
    }

    private static SourceGuard Guard(EngineOptions o, string ip) => new(o, _ => Task.FromResult(new[] { IPAddress.Parse(ip) }));

    [Theory]
    [InlineData("https://lax5-4.download.real-debrid.com/d/X/file.mkv", "104.18.1.1", true)]
    [InlineData("https://real-debrid.com.evil.example/file.mkv", "104.18.1.1", false)]
    [InlineData("http://lax5-4.download.real-debrid.com/d/X/file.mkv", "104.18.1.1", false)]
    [InlineData("https://lax5-4.download.real-debrid.com/d/X/file.mkv", "10.0.0.5", false)]   // DNS rebinding to LAN
    [InlineData("https://169.254.169.254/latest/meta-data", "169.254.169.254", false)]
    [InlineData("https://user:pass@download.real-debrid.com/x.mkv", "104.18.1.1", false)]
    public async Task UrlAllowlist(string url, string resolved, bool allowed)
    {
        var guard = Guard(new EngineOptions(), resolved);
        if (allowed) await guard.ValidateUrlAsync(url);
        else await Assert.ThrowsAsync<SourceRejectedException>(() => guard.ValidateUrlAsync(url));
    }

    [Fact]
    public async Task ExplicitPrivateHost_IsAllowed()
    {
        // 192.0.2.0/24 is TEST-NET-1 (documentation range).
        var guard = Guard(new EngineOptions { AllowedPrivateHosts = ["192.0.2.10"] }, "192.0.2.10");
        await guard.ValidateUrlAsync("http://192.0.2.10:32400/library/parts/1/file.mkv?token=t");
        // The same host is rejected when it is not explicitly allowed.
        await Assert.ThrowsAsync<SourceRejectedException>(() =>
            Guard(new EngineOptions(), "192.0.2.10").ValidateUrlAsync("http://192.0.2.10:32400/library/parts/1/file.mkv"));
    }

    [Fact]
    public void Files_MustStayInsideLibraryRoots()
    {
        var root = Path.Combine(Path.GetTempPath(), "notflix-guard-" + Guid.NewGuid().ToString("N")[..6]);
        Directory.CreateDirectory(root);
        var inside = Path.Combine(root, "movie.mkv");
        File.WriteAllText(inside, "x");
        try
        {
            var guard = new SourceGuard(new EngineOptions { LibraryRoots = [root] });
            Assert.Equal(inside, guard.ValidateFile(inside));
            Assert.Throws<SourceRejectedException>(() => guard.ValidateFile(Path.Combine(root, "..", "elsewhere.mkv")));
            Assert.Throws<SourceRejectedException>(() => guard.ValidateFile(root + "-sibling\\movie.mkv"));
            Assert.Throws<SourceRejectedException>(() => guard.ValidateFile(@"C:\Windows\win.ini"));
        }
        finally { Directory.Delete(root, true); }
    }

    [Theory]
    [InlineData("10.1.2.3", true)]
    [InlineData("172.20.0.1", true)]
    [InlineData("192.168.1.1", true)]
    [InlineData("100.64.0.1", true)]
    [InlineData("::1", true)]
    [InlineData("fd00::1", true)]
    [InlineData("8.8.8.8", false)]
    [InlineData("104.18.1.1", false)]
    public void PrivateAddressDetection(string ip, bool isPrivate) =>
        Assert.Equal(isPrivate, SourceGuard.IsPrivate(IPAddress.Parse(ip)));
}

public class ProbeParsingTests
{
    [Fact]
    public void ParsesHdrDolbyVisionAndTracks()
    {
        const string json = """
        {"streams":[
          {"index":0,"codec_type":"video","codec_name":"hevc","profile":"Main 10","width":3840,"height":2160,"pix_fmt":"yuv420p10le",
           "avg_frame_rate":"24000/1001","color_transfer":"smpte2084","color_primaries":"bt2020",
           "side_data_list":[{"side_data_type":"DOVI configuration record","dv_profile":8}]},
          {"index":1,"codec_type":"audio","codec_name":"truehd","channels":8,"tags":{"language":"eng","title":"Atmos"},"disposition":{"default":1}},
          {"index":2,"codec_type":"subtitle","codec_name":"hdmv_pgs_subtitle","tags":{"language":"eng"},"disposition":{"forced":1}},
          {"index":3,"codec_type":"video","codec_name":"mjpeg","disposition":{"attached_pic":1}}
        ],"format":{"format_name":"matroska,webm","duration":"7200.5","start_time":"0.000","bit_rate":"45000000","size":"40500000000"}}
        """;
        var p = MediaProbe.Parse(json);
        Assert.Equal("matroska", p.Container);
        Assert.Equal(10, p.Video!.BitDepth);
        Assert.Equal("Dolby Vision (HDR10 base)", p.Video.DynamicRange);
        Assert.Equal(8, p.Video.DolbyVisionProfile);
        Assert.Equal(23.976, p.Video.FrameRate!.Value, 3);
        Assert.Equal(0, p.Video.Index); // cover art (attached_pic) is ignored
        Assert.Equal("truehd", p.Audio[0].Codec);
        Assert.True(p.Subtitles[0].IsImage && p.Subtitles[0].Forced);
        Assert.Equal(7200.5, p.Duration);
    }
}
