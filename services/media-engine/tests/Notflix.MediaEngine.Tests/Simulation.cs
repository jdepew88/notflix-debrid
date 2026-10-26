using Microsoft.Extensions.Logging.Abstractions;
using Notflix.MediaEngine.Media;
using Notflix.MediaEngine.Processes;

namespace Notflix.MediaEngine.Tests;

/// <summary>
/// A simulated machine for hardware-detection tests: canned output for ffmpeg listings, test encodes,
/// hardware decodes, nvidia-smi, PowerShell CIM, system_profiler and Linux sysfs. Nothing here runs a
/// real process. Tests using it carry [Trait("Category", "Simulated")].
/// </summary>
public sealed class SimulatedBox
{
    public HostOs Os { get; init; } = HostOs.Windows;
    public bool FfmpegMissing { get; init; }
    public List<string> Encoders { get; init; } = ["libx264", "libx265", "libsvtav1", "libvpx-vp9", "mpeg2video", "mpeg4", "aac", "libopus"];
    public List<string> Decoders { get; init; } = [];
    public List<string> Hwaccels { get; init; } = [];
    public List<string> Filters { get; init; } = ["zscale", "tonemap"];
    /// <summary>Hardware encoders whose test encode succeeds.</summary>
    public HashSet<string> WorkingEncoders { get; init; } = [];
    /// <summary>Failure text per encoder (default: a generic device error).</summary>
    public Dictionary<string, string> EncoderErrors { get; init; } = [];
    /// <summary>Hardware decode results: key "cuda", "d3d11:1002", "d3d11:8086", "vaapi", "videotoolbox_vld" → codecs that decode.</summary>
    public Dictionary<string, HashSet<string>> WorkingDecode { get; init; } = [];
    /// <summary>"Using device" text D3D11VA prints per vendor id.</summary>
    public Dictionary<string, string> D3d11Devices { get; init; } = [];
    public bool Libplacebo { get; init; }
    public string? PowershellJson { get; init; }
    public string? NvidiaSmi { get; init; }
    public string? SystemProfilerJson { get; init; }
    /// <summary>Linux sysfs/devfs: file path → content.</summary>
    public Dictionary<string, string> Files { get; init; } = [];
    /// <summary>Linux sysfs: directory path → child directory names.</summary>
    public Dictionary<string, List<string>> Directories { get; init; } = [];

    public static string Listing(IEnumerable<string> names) =>
        "Encoders/Decoders:\n ------\n" + string.Join("\n", names.Select(n => $" V....D {n,-20} simulated entry"));
}

public sealed class FakeProcessRunner(SimulatedBox box) : IProcessRunner
{
    public List<(string File, IReadOnlyList<string> Args)> Calls { get; } = [];

    private static ProcessResult Ok(string stdout = "", string stderr = "") => new(0, stdout, stderr, false);
    private static ProcessResult Fail(string stderr, int code = 1) => new(code, "", stderr, false);
    private static ProcessResult NotInstalled => new(-1, "", "The system cannot find the file specified.", false);

    public Task<ProcessResult> RunAsync(string fileName, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct = default)
    {
        lock (Calls) Calls.Add((fileName, args));
        return Task.FromResult(Run(fileName, args));
    }

    public bool Ran(string file, params string[] contains)
    {
        lock (Calls) return Calls.Any(c => c.File == file && contains.All(c.Args.Contains));
    }

    private ProcessResult Run(string file, IReadOnlyList<string> args)
    {
        string? After(string flag) { var i = args.ToList().IndexOf(flag); return i >= 0 && i + 1 < args.Count ? args[i + 1] : null; }
        switch (file)
        {
            case "powershell":
                return box.Os == HostOs.Windows && box.PowershellJson is { } ps ? Ok(ps) : NotInstalled;
            case "nvidia-smi":
                return box.NvidiaSmi is { } smi ? Ok(smi) : NotInstalled;
            case "system_profiler":
                return box.Os == HostOs.MacOS && box.SystemProfilerJson is { } sp ? Ok(sp) : NotInstalled;
        }
        if (box.FfmpegMissing) return NotInstalled;
        if (file.Contains("ffprobe")) return args.Contains("-version") ? Ok("ffprobe version 8.1-sim Copyright (c) the FFmpeg developers") : Fail("unexpected");
        if (!file.Contains("ffmpeg")) return NotInstalled;

        if (args.Contains("-version")) return Ok("ffmpeg version 8.1-sim Copyright (c) 2000-2026 the FFmpeg developers");
        if (args.Contains("-encoders")) return Ok(SimulatedBox.Listing(box.Encoders));
        if (args.Contains("-decoders")) return Ok(SimulatedBox.Listing(box.Decoders));
        if (args.Contains("-filters")) return Ok(SimulatedBox.Listing(box.Filters));
        if (args.Contains("-hwaccels")) return Ok("Hardware acceleration methods:\n" + string.Join("\n", box.Hwaccels) + "\n");

        if (args.Any(a => a.Contains("libplacebo")))
            return box.Libplacebo ? Ok() : Fail("[Vulkan] No compatible device found");

        // Hardware decode verification.
        if (After("-hwaccel_output_format") is { } fmt)
        {
            var input = After("-i") ?? "";
            var codec = Path.GetFileNameWithoutExtension(input);
            var key = fmt;
            string? stderr = null;
            if (fmt == "d3d11")
            {
                var init = After("-init_hw_device") ?? "";
                var vendor = init.Contains("vendor_id=0x") ? init[(init.IndexOf("vendor_id=0x", StringComparison.Ordinal) + 12)..] : "1002";
                key = $"d3d11:{vendor}";
                if (!box.D3d11Devices.TryGetValue(vendor, out var dev))
                    return Fail($"[D3D11VA @ 000001f3210cd300] Failed to find d3d11va adapter by vendor id 0x{vendor}\nDevice creation failed: -1313558101.");
                stderr = $"[D3D11VA @ 0000022f420451c0] Selecting d3d11va adapter 1\n[D3D11VA @ 0000022f420451c0] Using device {dev}.\n";
            }
            return box.WorkingDecode.TryGetValue(key, out var codecs) && codecs.Contains(codec)
                ? Ok("", stderr ?? "")
                : Fail("Impossible to convert between the formats supported by the filter 'graph -1 input from stream 0:0' and the filter 'auto_scale_0'");
        }

        // Test encodes (-f lavfi ... -frames:v 15 ... -f null -).
        if (args.Contains("lavfi") && After("-frames:v") == "15" && After("-c:v") is { } enc)
        {
            if (box.WorkingEncoders.Contains(enc)) return Ok();
            return Fail(box.EncoderErrors.TryGetValue(enc, out var err) ? err : $"[{enc} @ 0x55d0c0] No device available for encoder (device type for {enc}).");
        }

        // Decode sample generation (-y ... file.mkv).
        if (args.Contains("-y") && args[^1].EndsWith(".mkv", StringComparison.Ordinal)) return Ok();
        return Fail("unexpected simulated command: " + string.Join(' ', args));
    }
}

public sealed class FakePlatform(SimulatedBox box) : IHostPlatform
{
    public HostOs Os => box.Os;
    public string Arch => box.Os == HostOs.MacOS ? "arm64" : "x64";
    public string OsDescription => $"Simulated {box.Os}";
    public bool FileExists(string path) => box.Files.ContainsKey(path);
    public string? ReadText(string path) => box.Files.TryGetValue(path, out var s) ? s : null;

    public IEnumerable<string> EnumerateDirectories(string path, string pattern)
    {
        if (!box.Directories.TryGetValue(path, out var children)) return [];
        var prefix = pattern.TrimEnd('*');
        return children.Where(c => c.StartsWith(prefix, StringComparison.Ordinal)).Select(c => path + "/" + c);
    }
}

public static class Simulation
{
    public static (HardwareCapabilities Caps, FakeProcessRunner Runner) Detect(SimulatedBox box, EngineOptions? options = null)
    {
        options ??= new EngineOptions();
        options.TempDirectory = Path.Combine(Path.GetTempPath(), "notflix-sim-" + Guid.NewGuid().ToString("N")[..8]);
        var runner = new FakeProcessRunner(box);
        var ext = box.Os == HostOs.Windows ? ".exe" : "";
        var probe = new HardwareProbe(new FfmpegBinaries("ffmpeg" + ext, "ffprobe" + ext), options, runner, new FakePlatform(box),
            NullLogger<HardwareProbe>.Instance);
        try
        {
            return (probe.DetectAsync(CancellationToken.None).GetAwaiter().GetResult(), runner);
        }
        finally
        {
            try { Directory.Delete(options.TempDirectory, true); } catch { /* best effort */ }
        }
    }

    public static readonly string[] AllDecodeCodecs = ["h264", "hevc", "av1", "vp9", "mpeg2video", "mpeg4"];
    public static readonly string[] Cuvid = ["h264_cuvid", "hevc_cuvid", "av1_cuvid", "vp9_cuvid", "mpeg2_cuvid", "mpeg4_cuvid", "vc1_cuvid", "vp8_cuvid"];
    /// <summary>What a Windows "full" FFmpeg build lists, independent of the hardware present.</summary>
    public static readonly string[] WindowsHwEncoders =
        ["h264_nvenc", "hevc_nvenc", "av1_nvenc", "h264_qsv", "hevc_qsv", "av1_qsv", "h264_amf", "hevc_amf", "av1_amf"];
    public static readonly string[] WindowsHwaccels = ["cuda", "vaapi", "dxva2", "qsv", "d3d11va", "opencl", "vulkan", "d3d12va", "amf"];
    public static List<string> SoftwareEncoders => ["libx264", "libx265", "libsvtav1", "libvpx-vp9", "mpeg2video", "mpeg4", "aac", "libopus"];

    public const string PsNvidia = """{"Name":"NVIDIA GeForce RTX 4070","PNPDeviceID":"PCI\\VEN_10DE&DEV_2786&SUBSYS_00000000&REV_A1\\4&1&0&0008","DriverVersion":"32.0.15.0000","AdapterRAM":4293918720}""";
    public const string PsParsec = """{"Name":"Parsec Virtual Display Adapter","PNPDeviceID":"ROOT\\DISPLAY\\0000","DriverVersion":"0.45.0.0","AdapterRAM":null}""";
    public const string PsAmdIgpu = """{"Name":"AMD Radeon(TM) Graphics","PNPDeviceID":"PCI\\VEN_1002&DEV_164E&SUBSYS_00000000&REV_CB\\4&2&0&0041","DriverVersion":"32.0.21000.0","AdapterRAM":536870912}""";
    public const string PsAmdDgpu = """{"Name":"AMD Radeon RX 6700 XT","PNPDeviceID":"PCI\\VEN_1002&DEV_73DF&SUBSYS_00000000&REV_C1\\4&3&0&0008","DriverVersion":"32.0.21000.0","AdapterRAM":4293918720}""";
    public const string PsIntel = """{"Name":"Intel(R) UHD Graphics 770","PNPDeviceID":"PCI\\VEN_8086&DEV_4680&SUBSYS_00000000&REV_0C\\3&1&0&0010","DriverVersion":"31.0.101.0000","AdapterRAM":2147483648}""";
    public const string PsBasic = """{"Name":"Microsoft Basic Display Adapter","PNPDeviceID":"PCI\\VEN_1234&DEV_1111&SUBSYS_00000000&REV_02\\3&1&0&0010","DriverVersion":"10.0.0.0","AdapterRAM":null}""";
    public const string SmiOne = "0, NVIDIA GeForce RTX 4070, 560.00, 12282\n";

    /// <summary>Windows desktop with an NVIDIA card and a Parsec virtual display.</summary>
    public static SimulatedBox NvidiaWindows() => new()
    {
        Os = HostOs.Windows,
        Encoders = [.. SoftwareEncoders, .. WindowsHwEncoders],
        Decoders = [.. Cuvid],
        Hwaccels = [.. WindowsHwaccels],
        Filters = ["zscale", "tonemap", "libplacebo"],
        Libplacebo = true,
        WorkingEncoders = ["h264_nvenc", "hevc_nvenc", "av1_nvenc"],
        WorkingDecode = new() { ["cuda"] = [.. AllDecodeCodecs] },
        PowershellJson = $"[{PsNvidia},{PsParsec}]",
        NvidiaSmi = SmiOne,
    };

    /// <summary>Windows PC with only an Intel iGPU (Quick Sync).</summary>
    public static SimulatedBox IntelWindows() => new()
    {
        Os = HostOs.Windows,
        Encoders = [.. SoftwareEncoders, .. WindowsHwEncoders],
        Decoders = [.. Cuvid],
        Hwaccels = [.. WindowsHwaccels],
        WorkingEncoders = ["h264_qsv", "hevc_qsv", "av1_qsv"],
        WorkingDecode = new() { ["d3d11:8086"] = ["h264", "hevc", "av1", "vp9", "mpeg2video"] },
        D3d11Devices = new() { ["8086"] = "8086:4680 (Intel(R) UHD Graphics 770)" },
        PowershellJson = PsIntel, // a single adapter: CIM emits an object, not an array
    };

    /// <summary>Windows PC with an RDNA2 AMD GPU: AMF H.264/HEVC work, AV1 encode does not exist.</summary>
    public static SimulatedBox AmdWindows() => new()
    {
        Os = HostOs.Windows,
        Encoders = [.. SoftwareEncoders, .. WindowsHwEncoders],
        Decoders = [.. Cuvid],
        Hwaccels = [.. WindowsHwaccels],
        WorkingEncoders = ["h264_amf", "hevc_amf"],
        EncoderErrors = new() { ["av1_amf"] = "[av1_amf @ 0000018d8fe3d040] CreateComponent(AMFVideoEncoderHW_AV1) failed with error 30" },
        WorkingDecode = new() { ["d3d11:1002"] = ["h264", "hevc", "av1", "vp9"] },
        D3d11Devices = new() { ["1002"] = "1002:73df (AMD Radeon RX 6700 XT)" },
        PowershellJson = $"[{PsAmdDgpu},{PsBasic}]",
    };

    /// <summary>Linux box with an AMD GPU on Mesa (radeonsi VAAPI), FFmpeg without AMF/QSV/NVENC.</summary>
    public static SimulatedBox VaapiLinux() => new()
    {
        Os = HostOs.Linux,
        Encoders = [.. SoftwareEncoders, "h264_vaapi", "hevc_vaapi", "av1_vaapi"],
        Hwaccels = ["vaapi", "vdpau", "drm", "vulkan"],
        WorkingEncoders = ["h264_vaapi", "hevc_vaapi"],
        WorkingDecode = new() { ["vaapi"] = ["h264", "hevc", "vp9", "av1"] },
        Directories = new()
        {
            ["/sys/class/drm"] = ["card0", "card0-DP-1", "renderD128"],
            ["/sys/class/drm/card0/device/drm"] = ["card0", "renderD128"],
        },
        Files = new()
        {
            ["/sys/class/drm/card0/device/vendor"] = "0x1002\n",
            ["/sys/class/drm/card0/device/device"] = "0x73df\n",
            ["/sys/class/drm/card0/device/uevent"] = "DRIVER=amdgpu\nPCI_CLASS=30000\n",
            ["/dev/dri/renderD128"] = "",
        },
    };

    /// <summary>Apple Silicon Mac (VideoToolbox).</summary>
    public static SimulatedBox VideoToolboxMac() => new()
    {
        Os = HostOs.MacOS,
        Encoders = [.. SoftwareEncoders, "h264_videotoolbox", "hevc_videotoolbox", "prores_videotoolbox"],
        Hwaccels = ["videotoolbox"],
        WorkingEncoders = ["h264_videotoolbox", "hevc_videotoolbox"],
        WorkingDecode = new() { ["videotoolbox_vld"] = ["h264", "hevc", "vp9"] },
        SystemProfilerJson = """{"SPDisplaysDataType":[{"_name":"Apple M2","sppci_model":"Apple M2","spdisplays_vendor":"sppci_vendor_Apple","sppci_cores":"10"}]}""",
    };

    /// <summary>Headless Linux server/VM with no GPU at all.</summary>
    public static SimulatedBox NoGpuLinux() => new()
    {
        Os = HostOs.Linux,
        Encoders = [.. SoftwareEncoders, "h264_vaapi", "h264_nvenc", "h264_qsv"],
        Hwaccels = ["vaapi", "vdpau", "cuda", "qsv"],
    };

    /// <summary>A desktop like the original developer's: NVIDIA dGPU + AMD iGPU + Parsec virtual display.</summary>
    public static SimulatedBox NvidiaPlusAmdWindows() => new()
    {
        Os = HostOs.Windows,
        Encoders = [.. SoftwareEncoders, .. WindowsHwEncoders],
        Decoders = [.. Cuvid],
        Hwaccels = [.. WindowsHwaccels],
        Filters = ["zscale", "tonemap", "libplacebo"],
        Libplacebo = true,
        WorkingEncoders = ["h264_nvenc", "hevc_nvenc", "av1_nvenc", "h264_amf", "hevc_amf"],
        EncoderErrors = new() { ["av1_amf"] = "[av1_amf @ 0000018d8fe3d040] CreateComponent(AMFVideoEncoderHW_AV1) failed with error 30" },
        WorkingDecode = new() { ["cuda"] = [.. AllDecodeCodecs], ["d3d11:1002"] = ["h264", "hevc", "av1", "vp9"] },
        D3d11Devices = new() { ["1002"] = "1002:164e (AMD Radeon(TM) Graphics)" },
        PowershellJson = $"[{PsNvidia},{PsParsec},{PsAmdIgpu}]",
        NvidiaSmi = SmiOne,
    };
}
