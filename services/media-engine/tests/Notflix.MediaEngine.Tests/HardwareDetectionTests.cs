using Microsoft.Extensions.Logging.Abstractions;
using Notflix.MediaEngine.Media;
using Notflix.MediaEngine.Monitoring;
using Notflix.MediaEngine.Playback;
using Notflix.MediaEngine.Security;

namespace Notflix.MediaEngine.Tests;

/// <summary>Hardware detection against simulated machines (canned process output; no real GPUs involved).</summary>
[Trait("Category", "Simulated")]
public class SimulatedHardwareDetectionTests
{
    private static BackendReport Backend(HardwareCapabilities caps, string id) => caps.Backends.Single(b => b.Id == id);

    [Fact]
    public void Simulated_NvidiaBox_VerifiesNvencAndNvdec_FlagsVirtualAdapter()
    {
        var (caps, runner) = Simulation.Detect(Simulation.NvidiaWindows());
        Assert.True(caps.FfmpegAvailable);
        Assert.Equal("windows", caps.Platform.Os);
        Assert.Equal(2, caps.Adapters.Count);
        Assert.Equal("nvidia", caps.Adapters[0].Vendor);
        Assert.Equal(0, caps.Adapters[0].NvidiaIndex);
        Assert.True(caps.Adapters[1].Virtual); // Parsec (ROOT\DISPLAY)
        Assert.True(caps.NvidiaSmiAvailable);
        Assert.Equal("NVIDIA GeForce RTX 4070", caps.GpuName);

        var nvenc = Backend(caps, "nvenc");
        Assert.Equal("verified", nvenc.Status);
        Assert.All(nvenc.Encoders.Values, s => Assert.Equal("verified", s));
        Assert.All(nvenc.Decoders.Values, s => Assert.Equal("verified", s));
        Assert.Contains("vc1", caps.ListedHardwareDecoders);
        // AMF/QSV are listed by the build but fail without their hardware: detected, never verified.
        Assert.Equal("detected", Backend(caps, "amf").Status);
        Assert.Equal("detected", Backend(caps, "qsv").Status);
        Assert.Contains(Backend(caps, "qsv").Notes, n => n.Contains("No Intel adapter"));
        Assert.Equal("unsupported", Backend(caps, "vaapi").Status);
        Assert.Equal("unsupported", Backend(caps, "videotoolbox").Status);
        Assert.Equal("nvenc", BackendSelector.Select(caps, "auto", null).Effective);
        Assert.True(runner.Ran("nvidia-smi"));
        Assert.True(caps.LibplaceboTonemap);
    }

    [Fact]
    public void Simulated_IntelBox_SelectsQsvWithD3d11Decode()
    {
        var (caps, _) = Simulation.Detect(Simulation.IntelWindows());
        Assert.Single(caps.Adapters);
        Assert.Equal("intel", caps.Adapters[0].Vendor);
        Assert.False(caps.NvidiaSmiAvailable);
        var qsv = Backend(caps, "qsv");
        Assert.Equal("verified", qsv.Status);
        Assert.Equal("verified", qsv.Encoders["av1"]);
        Assert.Equal("verified", qsv.Decoders["mpeg2video"]);
        Assert.Equal("failed", qsv.Decoders["mpeg4"]);
        Assert.Contains("Intel(R) UHD Graphics 770", qsv.Device);
        Assert.Equal("detected", Backend(caps, "nvenc").Status);
        Assert.Equal("verified", Backend(caps, "d3d11va").Status);
        Assert.Equal("d3d11va", caps.DecodePaths["qsv"].Hwaccel);
        Assert.Contains("d3d11va=dx,vendor_id=0x8086", caps.DecodePaths["qsv"].InputArgs);
        var sel = BackendSelector.Select(caps, "auto", null);
        Assert.Equal("qsv", sel.Effective);
        Assert.Null(sel.FallbackReason);
    }

    [Fact]
    public void Simulated_AmdBox_AmfH264AndHevcVerified_Av1FailedWithReason()
    {
        var (caps, runner) = Simulation.Detect(Simulation.AmdWindows());
        var amf = Backend(caps, "amf");
        Assert.Equal("verified", amf.Status);
        Assert.Equal("verified", amf.Encoders["h264"]);
        Assert.Equal("verified", amf.Encoders["hevc"]);
        Assert.Equal("failed", amf.Encoders["av1"]);
        var note = Assert.Single(amf.Notes, n => n.StartsWith("av1_amf:"));
        Assert.Contains("CreateComponent(AMFVideoEncoderHW_AV1) failed with error 30", note);
        Assert.DoesNotContain("0000018d8fe3d040", note); // object addresses are stripped
        Assert.Contains("h264_amf", caps.VerifiedEncoders);
        Assert.DoesNotContain("av1_amf", caps.VerifiedEncoders);
        Assert.True(caps.Adapters.Single(a => a.Name.StartsWith("Microsoft Basic")).Virtual);
        Assert.Equal("amf", BackendSelector.Select(caps, "auto", null).Effective);
        Assert.False(runner.Ran("nvidia-smi")); // no NVIDIA adapter: nvidia-smi is not even started
        // AMF test encodes feed NV12 frames.
        Assert.True(runner.Ran("ffmpeg.exe", "-c:v", "h264_amf", "-pix_fmt", "nv12"));
    }

    [Fact]
    public void Simulated_LinuxVaapiBox_UsesRenderNodeAndUploads()
    {
        var (caps, runner) = Simulation.Detect(Simulation.VaapiLinux());
        Assert.Equal("linux", caps.Platform.Os);
        var adapter = Assert.Single(caps.Adapters);
        Assert.Equal("amd", adapter.Vendor);
        Assert.Equal("amdgpu", adapter.Driver);
        Assert.Equal("/dev/dri/renderD128", adapter.RenderNode);
        var vaapi = Backend(caps, "vaapi");
        Assert.Equal("verified", vaapi.Status);
        Assert.Equal("failed", vaapi.Encoders["av1"]);
        Assert.Equal("/dev/dri/renderD128", vaapi.Device);
        Assert.True(runner.Ran("ffmpeg", "-vaapi_device", "/dev/dri/renderD128", "format=nv12,hwupload", "h264_vaapi"));
        Assert.Equal("unsupported", Backend(caps, "d3d11va").Status);
        Assert.Equal("unsupported", Backend(caps, "amf").Status); // not in this build
        Assert.Equal("vaapi", BackendSelector.Select(caps, "auto", null).Effective);
        Assert.Contains("hevc", caps.DecodePaths["vaapi"].Verified);
    }

    [Fact]
    public void Simulated_MacBox_VideoToolbox()
    {
        var (caps, runner) = Simulation.Detect(Simulation.VideoToolboxMac());
        Assert.Equal("macos", caps.Platform.Os);
        Assert.Equal("apple", Assert.Single(caps.Adapters).Vendor);
        var vt = Backend(caps, "videotoolbox");
        Assert.Equal("verified", vt.Status);
        Assert.Equal("not-listed", vt.Encoders["av1"]);
        Assert.Equal("unsupported", Backend(caps, "nvenc").Status);
        Assert.True(runner.Ran("ffmpeg", "-c:v", "h264_videotoolbox", "-allow_sw", "0"));
        Assert.False(runner.Ran("nvidia-smi"));
        Assert.Equal("videotoolbox", BackendSelector.Select(caps, "auto", null).Effective);
    }

    [Fact]
    public void Simulated_NoGpuBox_FallsBackToSoftware()
    {
        var (caps, _) = Simulation.Detect(Simulation.NoGpuLinux());
        Assert.True(caps.FfmpegAvailable);
        Assert.Empty(caps.Adapters);
        Assert.Empty(caps.VerifiedEncoders);
        Assert.False(caps.NvidiaSmiAvailable);
        Assert.All(caps.Backends, b => Assert.NotEqual("verified", b.Status));
        Assert.Equal("unsupported", Backend(caps, "vaapi").Status); // no render node
        var sel = BackendSelector.Select(caps, "auto", null);
        Assert.Equal("software", sel.Effective);
        Assert.Contains("libx264", caps.SoftwareEncoders);
    }

    [Fact]
    public void Simulated_MissingFfmpeg_ReportsUnavailableWithoutCrashing()
    {
        var (caps, _) = Simulation.Detect(new SimulatedBox { Os = HostOs.Windows, FfmpegMissing = true, PowershellJson = Simulation.PsAmdDgpu });
        Assert.False(caps.FfmpegAvailable);
        Assert.False(caps.FfprobeAvailable);
        Assert.Single(caps.Adapters); // adapters are still reported
        Assert.All(caps.Backends, b => Assert.Equal("unsupported", b.Status));
        Assert.Contains("FFmpeg was not found", caps.Backends[0].Notes[0]);
        Assert.Equal("software", BackendSelector.Select(caps, "auto", null).Effective);
    }

    [Fact]
    public async Task Simulated_MissingFfmpeg_SessionCreationFailsWithReadableError()
    {
        var options = new EngineOptions { TempDirectory = Path.Combine(Path.GetTempPath(), "notflix-sim-" + Guid.NewGuid().ToString("N")[..8]) };
        var box = new SimulatedBox { Os = HostOs.Windows, FfmpegMissing = true };
        var binaries = new FfmpegBinaries("ffmpeg.exe", "ffprobe.exe") { FfmpegFound = false, FfprobeFound = false };
        var provider = new HardwareCapabilitiesProvider(new HardwareProbe(binaries, options, new FakeProcessRunner(box), new FakePlatform(box), NullLogger<HardwareProbe>.Instance));
        var sessions = new SessionManager(options, binaries, new MediaProber(binaries, options, NullLogger<MediaProber>.Instance), provider,
            new SourceGuard(options), new SystemMonitor(NullLogger<SystemMonitor>.Instance, provider), NullLogger<SessionManager>.Instance);
        var ex = await Assert.ThrowsAsync<FfmpegMissingException>(sessions.EnsureFfmpegAsync);
        Assert.Contains("FFmpeg is not installed", ex.Message);
        try { Directory.Delete(options.TempDirectory, true); } catch { /* best effort */ }
    }

    [Fact]
    public void Simulated_NvidiaPlusAmd_OwnerCanPickAmf_AndUnverifiedChoiceFallsBack()
    {
        var (caps, _) = Simulation.Detect(Simulation.NvidiaPlusAmdWindows());
        Assert.Equal("nvenc", BackendSelector.Select(caps, "auto", null).Effective);
        var amf = BackendSelector.Select(caps, "amf", null);
        Assert.Equal("amf", amf.Effective);
        Assert.Null(amf.FallbackReason);
        Assert.Equal("D3D11VA", caps.DecodePaths["amf"].Label);
        Assert.Contains("AMD Radeon(TM) Graphics", caps.DecodePaths["amf"].Adapter);

        var qsv = BackendSelector.Select(caps, "qsv", "0");
        Assert.Equal("nvenc", qsv.Effective);
        Assert.Null(qsv.Device);
        Assert.Contains("QSV was requested but is not available", qsv.FallbackReason);
        Assert.Equal(("off", "software"), (BackendSelector.Select(caps, "off", null).Requested, BackendSelector.Select(caps, "off", null).Effective));
        Assert.Equal("auto", BackendSelector.Select(caps, "bogus", null).Requested);
    }

    [Fact]
    public void Simulated_NvencDeviceIndex_IsUsedForProbeAndPipelines()
    {
        var options = new EngineOptions { HardwareAcceleration = "nvenc", HardwareDevice = "1" };
        var (caps, runner) = Simulation.Detect(Simulation.NvidiaWindows(), options);
        Assert.True(runner.Ran("ffmpeg.exe", "-c:v", "h264_nvenc", "-gpu", "1"));
        Assert.True(runner.Ran("ffmpeg.exe", "-hwaccel", "cuda", "-hwaccel_device", "1"));
        var sel = BackendSelector.Select(caps, options.HardwareAcceleration, options.HardwareDevice);
        Assert.Equal(("nvenc", "1"), (sel.Effective, sel.Device));

        var probe = BackendLadderTests.Probe("hevc", 1080);
        var d = PlaybackDecider.Decide(probe, ClientCapabilities.Conservative, new PlaybackPreferences(), caps, options);
        var args = BackendLadderTests.Args(d, d.Attempts[0], probe);
        Assert.Equal("NVDEC + NVENC H.264", d.Attempts[0].Label);
        Assert.Equal("1", args[args.IndexOf("-gpu") + 1]);
        Assert.Equal("1", args[args.IndexOf("-hwaccel_device") + 1]);
        Assert.Equal("cuda", args[args.IndexOf("-hwaccel_output_format") + 1]); // full-GPU path unchanged
    }

    [Fact]
    public void Simulated_D3d11Decode_RejectsSilentCpuFallback()
    {
        // The decode check downloads hardware frames; software frames make the filter graph fail.
        var (caps, runner) = Simulation.Detect(Simulation.AmdWindows());
        Assert.True(runner.Ran("ffmpeg.exe", "-hwaccel_output_format", "d3d11", "hwdownload,format=nv12"));
        Assert.Equal("failed", Backend(caps, "amf").Decoders["mpeg2video"]);
        Assert.DoesNotContain("mpeg2video", caps.DecodePaths["amf"].Verified);
    }

    [Fact]
    public void Simulated_AdapterParsers()
    {
        var mac = GpuAdapterEnumerator.ParseMac("""{"SPDisplaysDataType":[{"sppci_model":"AMD Radeon Pro 5500M","spdisplays_vendor":"sppci_vendor_amd","spdisplays_vram":"8 GB"},{"sppci_model":"Intel UHD Graphics 630","spdisplays_vendor":"Intel","spdisplays_vram_shared":"1536 MB"}]}""");
        Assert.Equal(("amd", 8192L), (mac[0].Vendor, mac[0].MemoryMiB!.Value));
        Assert.Equal(("intel", 1536L), (mac[1].Vendor, mac[1].MemoryMiB!.Value));
        var win = GpuAdapterEnumerator.ParseWindows(Simulation.PsParsec);
        Assert.True(Assert.Single(win).Virtual);
        Assert.Equal("other", win[0].Vendor);
        var merged = GpuAdapterEnumerator.MergeNvidia([], [new NvidiaSmiInfo(0, "NVIDIA L4", "550.1", 23034)]);
        Assert.Equal(("nvidia", 0), (merged[0].Vendor, merged[0].NvidiaIndex!.Value));
    }
}

/// <summary>Decision ladder and FFmpeg arguments per backend (capabilities come from the simulated machines).</summary>
[Trait("Category", "Simulated")]
public class BackendLadderTests
{
    private static readonly EngineOptions Options = new();

    public static MediaProbe Probe(string codec, int height, int bitDepth = 8, bool hdr = false) => new()
    {
        FormatName = "matroska,webm",
        Duration = 600,
        Video = new VideoStreamInfo
        {
            Index = 0, Codec = codec, Width = height * 16 / 9, Height = height, BitDepth = bitDepth, FrameRate = 24,
            PixelFormat = bitDepth > 8 ? "yuv420p10le" : "yuv420p", ColorTransfer = hdr ? "smpte2084" : null, DynamicRange = hdr ? "HDR10" : "SDR",
        },
        Audio = [new AudioStreamInfo { Index = 1, Codec = "aac", Channels = 2, Language = "eng" }],
    };

    public static List<string> Args(PlaybackDecision d, PipelineAttempt attempt, MediaProbe probe) =>
        FfmpegArgsBuilder.BuildHls(new HlsJobSpec("/media/movie.mkv", false, probe, d, attempt, 0, Path.Combine(Path.GetTempPath(), "g1"), 4));

    private static HardwareCapabilities Caps(SimulatedBox box) => Simulation.Detect(box).Caps;

    [Fact]
    public void Amf_LadderIsD3d11ThenCpuThenX264()
    {
        var caps = Caps(Simulation.AmdWindows());
        var probe = Probe("hevc", 1080);
        var d = PlaybackDecider.Decide(probe, ClientCapabilities.Conservative, new PlaybackPreferences(), caps, Options);
        Assert.Equal(["D3D11VA + AMF H.264", "CPU decode + AMF H.264", "CPU decode + x264"], d.Attempts.Select(a => a.Label));
        Assert.All(d.Attempts.Take(2), a => Assert.True(a.HardwareEncode));
        Assert.False(d.Attempts[^1].HardwareEncode);

        var args = Args(d, d.Attempts[0], probe);
        Assert.Equal("d3d11va=dx,vendor_id=0x1002", args[args.IndexOf("-init_hw_device") + 1]);
        Assert.Equal("d3d11va", args[args.IndexOf("-hwaccel") + 1]);
        Assert.DoesNotContain("-hwaccel_output_format", args); // frames come back to system memory
        Assert.Equal("scale=1920:1080:flags=bicubic,format=nv12", args[args.IndexOf("-vf") + 1]);
        Assert.Equal("h264_amf", args[args.IndexOf("-c:v") + 1]);
        Assert.Equal("balanced", args[args.IndexOf("-quality") + 1]);
        Assert.Equal("vbr_peak", args[args.IndexOf("-rc") + 1]);
        Assert.Equal("high", args[args.IndexOf("-profile:v") + 1]);
        Assert.Equal("96", args[args.IndexOf("-g") + 1]);
        Assert.Contains("-maxrate", args);

        var cpu = Args(d, d.Attempts[1], probe);
        Assert.DoesNotContain("-hwaccel", cpu);
        Assert.DoesNotContain("-init_hw_device", cpu);
    }

    [Fact]
    public void Amf_CodecWithoutVerifiedHwDecode_StartsAtCpuDecode()
    {
        var caps = Caps(Simulation.AmdWindows());
        var d = PlaybackDecider.Decide(Probe("mpeg2video", 720), ClientCapabilities.Conservative, new PlaybackPreferences(), caps, Options);
        Assert.Equal("CPU decode + AMF H.264", d.Attempts[0].Label);
    }

    [Fact]
    public void Amf_HevcOutputOnlyFor4kHevcClients()
    {
        var caps = Caps(Simulation.AmdWindows());
        var client = new ClientCapabilities { DirectVideo = ["h264", "hevc"], MseVideo = ["h264", "hevc"], TenBit = [] };
        var probe = Probe("hevc", 2160, bitDepth: 10, hdr: true);
        var d = PlaybackDecider.Decide(probe, client, new PlaybackPreferences(), caps, Options);
        Assert.Equal("hevc", d.OutputVideoCodec);
        Assert.Equal("D3D11VA + AMF HEVC", d.Attempts[0].Label);
        var args = Args(d, d.Attempts[0], probe);
        Assert.Equal("hevc_amf", args[args.IndexOf("-c:v") + 1]);
        Assert.Equal("main", args[args.IndexOf("-profile:v") + 1]);
        Assert.Equal("hvc1", args[args.IndexOf("-tag:v") + 1]);
        Assert.Equal(TonemapMethod.Cpu, d.Attempts[0].Tonemap); // no libplacebo on this box
    }

    [Fact]
    public void Qsv_UsesD3d11OnIntelAndQsvRateControl()
    {
        var caps = Caps(Simulation.IntelWindows());
        var probe = Probe("h264", 1080, bitDepth: 10); // Hi10P: no hardware decode anywhere
        var d = PlaybackDecider.Decide(probe, ClientCapabilities.Conservative, new PlaybackPreferences(), caps, Options);
        Assert.Equal("CPU decode + QSV H.264", d.Attempts[0].Label);
        var hevc = PlaybackDecider.Decide(Probe("hevc", 1080), ClientCapabilities.Conservative, new PlaybackPreferences(), caps, Options);
        Assert.Equal("D3D11VA + QSV H.264", hevc.Attempts[0].Label);
        var args = Args(hevc, hevc.Attempts[0], Probe("hevc", 1080));
        Assert.Equal("d3d11va=dx,vendor_id=0x8086", args[args.IndexOf("-init_hw_device") + 1]);
        Assert.Equal("h264_qsv", args[args.IndexOf("-c:v") + 1]);
        Assert.Equal("medium", args[args.IndexOf("-preset") + 1]);
        Assert.Equal("0", args[args.IndexOf("-look_ahead") + 1]);
        Assert.EndsWith("format=nv12", args[args.IndexOf("-vf") + 1]);
    }

    [Fact]
    public void Vaapi_UploadsFramesAndAvoidsVulkanToneMapping()
    {
        var caps = Caps(Simulation.VaapiLinux());
        var probe = Probe("hevc", 1080);
        var d = PlaybackDecider.Decide(probe, ClientCapabilities.Conservative, new PlaybackPreferences(), caps, Options);
        Assert.Equal(["VAAPI + VAAPI H.264", "CPU decode + VAAPI H.264", "CPU decode + x264"], d.Attempts.Select(a => a.Label));
        var args = Args(d, d.Attempts[0], probe);
        Assert.Equal("vaapi=va:/dev/dri/renderD128", args[args.IndexOf("-init_hw_device") + 1]);
        Assert.Equal("va", args[args.IndexOf("-filter_hw_device") + 1]);
        Assert.Equal("vaapi", args[args.IndexOf("-hwaccel") + 1]);
        Assert.True(args.IndexOf("-init_hw_device") < args.IndexOf("-hwaccel"), "device must exist before the decoder references it");
        Assert.Equal("scale=1920:1080:flags=bicubic,format=nv12,hwupload", args[args.IndexOf("-vf") + 1]);
        Assert.Equal("VBR", args[args.IndexOf("-rc_mode") + 1]);

        var cpu = Args(d, d.Attempts[1], probe);
        Assert.DoesNotContain("-hwaccel", cpu);
        Assert.Contains("-filter_hw_device", cpu); // encoder still needs the device

        var hdrCaps = new HardwareCapabilities
        {
            VerifiedEncoders = caps.VerifiedEncoders, DecodePaths = caps.DecodePaths, Devices = caps.Devices,
            LibplaceboTonemap = true, CpuTonemap = true,
        };
        var hdrProbe = Probe("hevc", 2160, 10, hdr: true);
        var hdr = PlaybackDecider.Decide(hdrProbe, ClientCapabilities.Conservative, new PlaybackPreferences(), hdrCaps, Options);
        Assert.All(hdr.Attempts, a => Assert.Equal(TonemapMethod.Cpu, a.Tonemap));
        var hdrArgs = Args(hdr, hdr.Attempts[0], hdrProbe);
        Assert.DoesNotContain("vulkan=vk", hdrArgs);
        Assert.EndsWith("format=nv12,hwupload", hdrArgs[hdrArgs.IndexOf("-vf") + 1]);
    }

    [Fact]
    public void VideoToolbox_RealtimeHardwareOnly()
    {
        var caps = Caps(Simulation.VideoToolboxMac());
        var probe = Probe("hevc", 1080);
        var d = PlaybackDecider.Decide(probe, ClientCapabilities.Conservative, new PlaybackPreferences(), caps, Options);
        Assert.Equal("VideoToolbox + VideoToolbox H.264", d.Attempts[0].Label);
        var args = Args(d, d.Attempts[0], probe);
        Assert.Equal("videotoolbox", args[args.IndexOf("-hwaccel") + 1]);
        Assert.Equal("h264_videotoolbox", args[args.IndexOf("-c:v") + 1]);
        Assert.Equal("0", args[args.IndexOf("-allow_sw") + 1]);
        Assert.Equal("1", args[args.IndexOf("-realtime") + 1]);
    }

    [Fact]
    public void NoGpu_OnlyX264_AndNoHardwareFlags()
    {
        var caps = Caps(Simulation.NoGpuLinux());
        var probe = Probe("hevc", 1080);
        var d = PlaybackDecider.Decide(probe, ClientCapabilities.Conservative, new PlaybackPreferences(), caps, Options);
        var only = Assert.Single(d.Attempts);
        Assert.Equal("CPU decode + x264", only.Label);
        var args = Args(d, only, probe);
        Assert.DoesNotContain(args, a => a.StartsWith("-hwaccel") || a == "-init_hw_device" || a == "-filter_hw_device");
        Assert.Contains("format=yuv420p", args[args.IndexOf("-vf") + 1]);
    }

    [Fact]
    public void SessionPreference_PicksBackend_AndUnavailableOneExplainsFallback()
    {
        var caps = Caps(Simulation.NvidiaPlusAmdWindows());
        var probe = Probe("hevc", 1080);
        var amf = PlaybackDecider.Decide(probe, ClientCapabilities.Conservative, new PlaybackPreferences { HardwareAcceleration = "amf" }, caps, Options);
        Assert.Equal("D3D11VA + AMF H.264", amf.Attempts[0].Label);
        var qsv = PlaybackDecider.Decide(probe, ClientCapabilities.Conservative, new PlaybackPreferences { HardwareAcceleration = "qsv" }, caps, Options);
        Assert.Equal("NVDEC + NVENC H.264", qsv.Attempts[0].Label);
        Assert.Contains(qsv.Reasons, r => r.StartsWith("QSV was requested but is not available"));
        var engineOff = PlaybackDecider.Decide(probe, ClientCapabilities.Conservative, new PlaybackPreferences { HardwareAcceleration = "amf" }, caps,
            new EngineOptions { HardwareAcceleration = "off" });
        Assert.Equal("CPU decode + x264", Assert.Single(engineOff.Attempts).Label);
        var engineAmf = PlaybackDecider.Decide(probe, ClientCapabilities.Conservative, new PlaybackPreferences(), caps,
            new EngineOptions { HardwareAcceleration = "amf" });
        Assert.Equal("D3D11VA + AMF H.264", engineAmf.Attempts[0].Label);
    }

    [Theory]
    [InlineData("h264_nvenc", true)]
    [InlineData("hevc_qsv", true)]
    [InlineData("h264_amf", true)]
    [InlineData("h264_vaapi", true)]
    [InlineData("hevc_videotoolbox", true)]
    [InlineData("libx264", false)]
    public void HardwareEncodeFlag_CoversEveryBackend(string encoder, bool hardware) =>
        Assert.Equal(hardware, new PipelineAttempt("x", false, encoder, TonemapMethod.None).HardwareEncode);
}
