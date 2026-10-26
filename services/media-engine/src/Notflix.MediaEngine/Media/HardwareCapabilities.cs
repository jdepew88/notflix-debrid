using System.Collections.Concurrent;
using System.Globalization;
using System.Text.RegularExpressions;
using Notflix.MediaEngine.Processes;

namespace Notflix.MediaEngine.Media;

public sealed record PlatformInfo(string Os, string Arch, string OsDescription);

public sealed class HardwareCapabilities
{
    public string FfmpegVersion { get; init; } = "unknown";
    public bool FfmpegAvailable { get; init; }
    public string? FfmpegPath { get; init; }
    public bool FfprobeAvailable { get; init; }
    public string? FfprobeVersion { get; init; }
    public string? FfprobePath { get; init; }
    public PlatformInfo Platform { get; init; } = new("other", "unknown", "");

    /// <summary>Primary GPU for display (NVIDIA from nvidia-smi when present, else the main physical adapter).</summary>
    public string? GpuName { get; init; }
    public string? DriverVersion { get; init; }
    public long? GpuMemoryMiB { get; init; }
    /// <summary>nvidia-smi answered (utilization sampling is possible).</summary>
    public bool NvidiaSmiAvailable { get; init; }

    /// <summary>Hardware encoders (any backend) that completed a real test encode on this machine.</summary>
    public HashSet<string> VerifiedEncoders { get; init; } = [];
    /// <summary>Source codecs that decoded on NVDEC (CUDA frames verified, no silent CPU fallback).</summary>
    public HashSet<string> VerifiedHardwareDecoders { get; init; } = [];
    /// <summary>NVDEC decoders ffmpeg lists but that could not be exercised (no sample encoder, e.g. VC-1).</summary>
    public HashSet<string> ListedHardwareDecoders { get; init; } = [];
    public bool LibplaceboTonemap { get; init; }
    public bool CpuTonemap { get; init; }
    public HashSet<string> SoftwareEncoders { get; init; } = [];
    public DateTimeOffset DetectedAt { get; init; } = DateTimeOffset.UtcNow;
    public double DetectionSeconds { get; init; }

    public List<GpuAdapter> Adapters { get; init; } = [];
    public List<BackendReport> Backends { get; init; } = [];
    /// <summary>Hardware decode paths for non-NVIDIA encode backends (key: backend id). NVENC uses the NVDEC fields above.</summary>
    public Dictionary<string, HwDecodePath> DecodePaths { get; init; } = [];
    /// <summary>Device options per encode backend (key: backend id).</summary>
    public Dictionary<string, BackendDevice> Devices { get; init; } = [];

    public bool NvencH264 => VerifiedEncoders.Contains("h264_nvenc");
    public bool NvencHevc => VerifiedEncoders.Contains("hevc_nvenc");
    public bool NvencAv1 => VerifiedEncoders.Contains("av1_nvenc");
}

/// <summary>
/// Detects what this host can actually do. Listing an encoder (or owning a GPU of some brand) is not
/// enough: every hardware path is exercised with a tiny encode/decode so the decision engine only plans
/// pipelines that work. Backends are probed in parallel; each step has a hard timeout.
/// </summary>
public sealed class HardwareProbe(
    FfmpegBinaries binaries,
    EngineOptions options,
    IProcessRunner runner,
    IHostPlatform platform,
    ILogger<HardwareProbe> logger)
{
    private static readonly TimeSpan StepTimeout = TimeSpan.FromSeconds(20);
    private const string TestSource = "testsrc2=size=640x360:rate=30";

    private sealed class EncodeOutcome
    {
        public Dictionary<string, string> Encoders { get; } = [];
        public List<string> Notes { get; } = [];
        public string? Device { get; set; }
    }

    public async Task<HardwareCapabilities> DetectAsync(CancellationToken ct)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var os = platform.Os;
        var platformInfo = new PlatformInfo(SystemHostPlatform.OsName(os), platform.Arch, platform.OsDescription);
        var adaptersTask = DetectAdaptersAsync(ct);

        var versionTask = runner.RunAsync(binaries.Ffmpeg, ["-hide_banner", "-version"], StepTimeout, ct);
        var probeVersionTask = runner.RunAsync(binaries.Ffprobe, ["-hide_banner", "-version"], StepTimeout, ct);
        var version = await versionTask;
        var probeVersion = await probeVersionTask;
        var ffprobeOk = probeVersion.ExitCode == 0;
        var ffprobeVer = ffprobeOk ? Regex.Match(probeVersion.StdOut, @"ffprobe version (\S+)").Groups[1].Value : null;
        var (adapters, smi) = await adaptersTask;
        var nvidia = smi.FirstOrDefault();

        if (version.ExitCode != 0)
        {
            logger.LogError("ffmpeg is not available at {Path}: {Error}", binaries.Ffmpeg, Shorten(version.StdErr));
            return new HardwareCapabilities
            {
                FfmpegAvailable = false,
                FfmpegPath = binaries.Ffmpeg,
                FfprobeAvailable = ffprobeOk,
                FfprobeVersion = ffprobeVer,
                FfprobePath = binaries.Ffprobe,
                Platform = platformInfo,
                Adapters = adapters,
                GpuName = nvidia?.Name ?? PrimaryAdapter(adapters)?.Name,
                DriverVersion = nvidia?.Driver ?? PrimaryAdapter(adapters)?.Driver,
                GpuMemoryMiB = nvidia?.MemoryMiB,
                NvidiaSmiAvailable = smi.Count > 0,
                Backends = [.. HwBackends.Priority.Append("d3d11va").Select(id => Unsupported(id, "FFmpeg was not found, so nothing could be tested"))],
                DetectionSeconds = Math.Round(sw.Elapsed.TotalSeconds, 2),
            };
        }
        var ffmpegVersion = Regex.Match(version.StdOut, @"ffmpeg version (\S+)").Groups[1].Value;

        var listings = await Task.WhenAll(
            runner.RunAsync(binaries.Ffmpeg, ["-hide_banner", "-encoders"], StepTimeout, ct),
            runner.RunAsync(binaries.Ffmpeg, ["-hide_banner", "-decoders"], StepTimeout, ct),
            runner.RunAsync(binaries.Ffmpeg, ["-hide_banner", "-filters"], StepTimeout, ct),
            runner.RunAsync(binaries.Ffmpeg, ["-hide_banner", "-hwaccels"], StepTimeout, ct));
        var encodersOut = listings[0].StdOut;
        var decodersOut = listings[1].StdOut;
        var filtersOut = listings[2].StdOut;
        var hwaccels = listings[3].StdOut.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(l => !l.Contains(':')).ToHashSet(StringComparer.OrdinalIgnoreCase);
        bool Listed(string output, string name) => Regex.IsMatch(output, $@"^\s*\S+\s+{Regex.Escape(name)}\s", RegexOptions.Multiline);

        var requested = BackendSelector.Normalize(options.HardwareAcceleration);
        var device = string.IsNullOrWhiteSpace(options.HardwareDevice) ? null : options.HardwareDevice.Trim();
        string? DeviceFor(string backend) => requested == backend ? device : null;
        int? IntDevice(string backend) => int.TryParse(DeviceFor(backend), NumberStyles.None, CultureInfo.InvariantCulture, out var i) ? i : null;

        var tmp = Path.Combine(options.HardwareProbeDirectory, Guid.NewGuid().ToString("N")[..8]);
        try { Directory.CreateDirectory(tmp); } catch (Exception ex) { logger.LogWarning("Probe directory unavailable: {Error}", ex.Message); }
        string Reason(ProcessResult r) => ShortReason(r, tmp);

        // --- Encode backends (parallel across backends, sequential within one) -------------------
        var nvencIndex = IntDevice("nvenc");
        var nvencDevice = new BackendDevice
        {
            EncoderArgs = nvencIndex is { } gi ? ["-gpu", gi.ToString(CultureInfo.InvariantCulture)] : [],
            HwaccelArgs = nvencIndex is { } hi ? ["-hwaccel_device", hi.ToString(CultureInfo.InvariantCulture)] : [],
            Description = nvencIndex is { } di ? $"GPU index {di}" : nvidia is not null ? $"{nvidia.Name} (index {nvidia.Index})" : null,
        };
        var vaapiNode = VaapiNode(DeviceFor("vaapi"), adapters, preferVendor: null);
        var vaapiDevice = vaapiNode is null ? new BackendDevice() : new BackendDevice
        {
            PreInputArgs = ["-init_hw_device", $"vaapi=va:{vaapiNode}", "-filter_hw_device", "va"],
            Description = vaapiNode,
        };

        async Task<EncodeOutcome> TestBackend(string backend, Func<string, string[]> commandFor, string? deviceLabel)
        {
            var outcome = new EncodeOutcome { Device = deviceLabel };
            foreach (var codec in HwBackends.EncodeCodecs)
            {
                var enc = HwBackends.EncoderName(backend, codec);
                if (!Listed(encodersOut, enc)) { outcome.Encoders[codec] = "not-listed"; continue; }
                var r = await runner.RunAsync(binaries.Ffmpeg, commandFor(enc), StepTimeout, ct);
                if (r.ExitCode == 0) outcome.Encoders[codec] = "verified";
                else
                {
                    outcome.Encoders[codec] = "failed";
                    outcome.Notes.Add($"{enc}: {Reason(r)}");
                    logger.LogInformation("{Encoder} listed but test encode failed: {Error}", enc, Reason(r));
                }
            }
            return outcome;
        }

        // Tiny real encode: [global/device options] -f lavfi -i testsrc2 -frames:v 15 [encoder options] -f null -
        static string[] Lavfi(string[] pre, string[] post) =>
            ["-hide_banner", "-v", "error", .. pre, "-f", "lavfi", "-i", TestSource, "-frames:v", "15", .. post, "-f", "null", "-"];

        var encodeTasks = new Dictionary<string, Task<EncodeOutcome>>();
        if (HwBackends.SupportedOn("nvenc", os))
            encodeTasks["nvenc"] = TestBackend("nvenc", enc => Lavfi([], ["-c:v", enc, .. nvencDevice.EncoderArgs]), nvencDevice.Description);
        if (HwBackends.SupportedOn("qsv", os))
            encodeTasks["qsv"] = TestBackend("qsv", enc => Lavfi(["-init_hw_device", os == HostOs.Windows ? "qsv=hw,child_device_type=d3d11va" : "qsv=hw"],
                ["-pix_fmt", "nv12", "-c:v", enc]), AdapterName(adapters, "intel"));
        if (HwBackends.SupportedOn("amf", os))
            encodeTasks["amf"] = TestBackend("amf", enc => Lavfi([], ["-pix_fmt", "nv12", "-c:v", enc]), AdapterName(adapters, "amd"));
        if (HwBackends.SupportedOn("vaapi", os) && vaapiNode is not null)
            encodeTasks["vaapi"] = TestBackend("vaapi", enc => Lavfi(["-vaapi_device", vaapiNode], ["-vf", "format=nv12,hwupload", "-c:v", enc]), vaapiNode);
        if (HwBackends.SupportedOn("videotoolbox", os))
            encodeTasks["videotoolbox"] = TestBackend("videotoolbox", enc => Lavfi([], ["-pix_fmt", "nv12", "-c:v", enc, "-allow_sw", "0"]), AdapterName(adapters, "apple"));
        await Task.WhenAll(encodeTasks.Values);
        var encodeResults = encodeTasks.ToDictionary(kv => kv.Key, kv => kv.Value.Result);

        var verifiedEncoders = new HashSet<string>();
        foreach (var (backend, outcome) in encodeResults)
            foreach (var (codec, status) in outcome.Encoders)
                if (status == "verified") verifiedEncoders.Add(HwBackends.EncoderName(backend, codec));
        bool EncVerified(string backend) => encodeResults.TryGetValue(backend, out var o) && o.Encoders.Values.Contains("verified");

        var software = new HashSet<string>();
        foreach (var enc in new[] { "libx264", "aac", "libopus", "libx265" })
            if (Listed(encodersOut, enc)) software.Add(enc);

        // --- Decode samples (one tiny file per codec, encoded once and shared by every decode test) --
        string[]? SampleEncoder(string codec) => codec switch
        {
            "h264" => Listed(encodersOut, "libx264") ? ["-c:v", "libx264", "-pix_fmt", "yuv420p"] : null,
            "hevc" => verifiedEncoders.Contains("hevc_nvenc") ? ["-c:v", "hevc_nvenc"]
                : Listed(encodersOut, "libx265") ? ["-c:v", "libx265", "-pix_fmt", "yuv420p"]
                : verifiedEncoders.FirstOrDefault(e => e.StartsWith("hevc_", StringComparison.Ordinal)) is { } he ? ["-pix_fmt", "nv12", "-c:v", he] : null,
            "av1" => verifiedEncoders.Contains("av1_nvenc") ? ["-c:v", "av1_nvenc"]
                : Listed(encodersOut, "libsvtav1") ? ["-c:v", "libsvtav1"]
                : verifiedEncoders.FirstOrDefault(e => e.StartsWith("av1_", StringComparison.Ordinal)) is { } ae ? ["-pix_fmt", "nv12", "-c:v", ae] : null,
            "vp9" => Listed(encodersOut, "libvpx-vp9") ? ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8"] : null,
            "mpeg2video" => Listed(encodersOut, "mpeg2video") ? ["-c:v", "mpeg2video"] : null,
            "mpeg4" => Listed(encodersOut, "mpeg4") ? ["-c:v", "mpeg4"] : null,
            _ => null,
        };

        // Decode paths to test: NVDEC for NVENC; D3D11VA (Windows) or VAAPI (Linux) on the vendor's adapter
        // for AMF/QSV; VAAPI for VAAPI; VideoToolbox for VideoToolbox.
        var nvdecWanted = HwBackends.SupportedOn("nvenc", os) && HwBackends.DecodeCodecs.Any(c => Listed(decodersOut, CuvidName(c)));
        var d3dVendors = new List<string>();
        if (os == HostOs.Windows && hwaccels.Contains("d3d11va"))
        {
            foreach (var vendor in new[] { "amd", "intel" })
            {
                var backend = vendor == "amd" ? "amf" : "qsv";
                var hasAdapter = adapters.Any(a => a.Vendor == vendor && !a.Virtual);
                if (hasAdapter || (adapters.Count == 0 && EncVerified(backend))) d3dVendors.Add(vendor);
            }
        }
        var linuxVaapiFor = new Dictionary<string, string>(); // backend → render node
        if (os == HostOs.Linux && hwaccels.Contains("vaapi"))
        {
            if (vaapiNode is not null && EncVerified("vaapi")) linuxVaapiFor["vaapi"] = vaapiNode;
            foreach (var (backend, vendor) in new[] { ("amf", "amd"), ("qsv", "intel") })
                if (EncVerified(backend) && VaapiNode(DeviceFor(backend), adapters, vendor) is { } node) linuxVaapiFor[backend] = node;
        }
        var vtWanted = os == HostOs.MacOS && hwaccels.Contains("videotoolbox") && EncVerified("videotoolbox");
        var anyDecode = nvdecWanted || d3dVendors.Count > 0 || linuxVaapiFor.Count > 0 || vtWanted;

        var samples = new ConcurrentDictionary<string, string>();
        if (anyDecode)
        {
            await Task.WhenAll(HwBackends.DecodeCodecs.Select(async codec =>
            {
                if (SampleEncoder(codec) is not { } encode) return;
                var file = Path.Combine(tmp, codec + ".mkv");
                var make = await runner.RunAsync(binaries.Ffmpeg,
                    ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", TestSource, "-frames:v", "20", .. encode, file], StepTimeout, ct);
                if (make.ExitCode == 0) samples[codec] = file;
            }));
        }

        // hwdownload fails unless frames really are hardware frames, so a silent CPU fallback cannot pass.
        async Task<(Dictionary<string, string> Results, List<string> Notes, string? Adapter)> TestDecode(
            string label, string[] deviceArgs, string outputFormat, Func<string, bool>? listed = null)
        {
            var results = new Dictionary<string, string>();
            var notes = new List<string>();
            string? adapter = null;
            foreach (var codec in HwBackends.DecodeCodecs)
            {
                if (listed is not null && !listed(codec)) { results[codec] = "not-listed"; continue; }
                if (!samples.TryGetValue(codec, out var file)) { results[codec] = "untested"; continue; }
                var verbose = adapter is null && deviceArgs.Any(a => a.StartsWith("d3d11va=", StringComparison.Ordinal));
                var r = await runner.RunAsync(binaries.Ffmpeg,
                    ["-hide_banner", "-v", verbose ? "verbose" : "error", .. deviceArgs, "-hwaccel_output_format", outputFormat, "-i", file,
                     "-vf", "hwdownload,format=nv12", "-f", "null", "-"], StepTimeout, ct);
                if (verbose && Regex.Match(r.StdErr, @"Using device ([0-9a-fA-F]{4}:[0-9a-fA-F]{4}) \((.*)\)\.?\s*$", RegexOptions.Multiline) is { Success: true } m)
                    adapter = $"{m.Groups[2].Value} [{m.Groups[1].Value}]";
                if (r.ExitCode == 0) results[codec] = "verified";
                else
                {
                    results[codec] = "failed";
                    notes.Add($"{label} {codec} decode: {Reason(r)}");
                }
            }
            return (results, notes, adapter);
        }

        var nvdecTask = nvdecWanted
            ? TestDecode("NVDEC", ["-hwaccel", "cuda", .. nvencDevice.HwaccelArgs], "cuda", c => Listed(decodersOut, CuvidName(c)))
            : null;
        var d3dTasks = d3dVendors.ToDictionary(v => v, v =>
        {
            var backend = v == "amd" ? "amf" : "qsv";
            return TestDecode($"D3D11VA ({GpuAdapterEnumerator.VendorLabel(v)})", D3d11Args(backend, v, IntDevice(backend)), "d3d11");
        });
        var vaapiTasks = linuxVaapiFor.ToDictionary(kv => kv.Key, kv =>
            TestDecode($"VAAPI {kv.Value}", ["-init_hw_device", $"vaapi=va:{kv.Value}", "-hwaccel", "vaapi", "-hwaccel_device", "va"], "vaapi"));
        var vtTask = vtWanted ? TestDecode("VideoToolbox", ["-hwaccel", "videotoolbox"], "videotoolbox_vld") : null;

        var libplaceboTask = Task.FromResult(false);
        if (Listed(filtersOut, "libplacebo"))
        {
            libplaceboTask = Task.Run(async () =>
            {
                var r = await runner.RunAsync(binaries.Ffmpeg,
                    ["-hide_banner", "-v", "error", "-init_hw_device", "vulkan=vk", "-filter_hw_device", "vk",
                     "-f", "lavfi", "-i", TestSource, "-frames:v", "5",
                     "-vf", "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,hwupload," +
                            "libplacebo=w=320:h=180:tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p," +
                            "hwdownload,format=yuv420p",
                     "-f", "null", "-"], StepTimeout, ct);
                if (r.ExitCode != 0) logger.LogInformation("libplacebo tone mapping unavailable: {Error}", Reason(r));
                return r.ExitCode == 0;
            }, ct);
        }

        var pending = new List<Task>();
        if (nvdecTask is not null) pending.Add(nvdecTask);
        pending.AddRange(d3dTasks.Values);
        pending.AddRange(vaapiTasks.Values);
        if (vtTask is not null) pending.Add(vtTask);
        pending.Add(libplaceboTask);
        try { await Task.WhenAll(pending); }
        finally
        {
            try { Directory.Delete(tmp, true); } catch { /* temp cleanup is best effort */ }
        }

        // --- Assemble reports -----------------------------------------------------------------------
        var verifiedNvdec = new HashSet<string>();
        var listedNvdec = new HashSet<string>();
        foreach (var c in HwBackends.DecodeCodecs) if (Listed(decodersOut, CuvidName(c))) listedNvdec.Add(c);
        if (Listed(decodersOut, "vc1_cuvid")) listedNvdec.Add("vc1");
        if (Listed(decodersOut, "vp8_cuvid")) listedNvdec.Add("vp8");
        var nvdec = nvdecTask?.Result;
        if (nvdec is { } nd) foreach (var (c, s) in nd.Results) if (s == "verified") verifiedNvdec.Add(c);

        var decodePaths = new Dictionary<string, HwDecodePath>();
        var reports = new List<BackendReport>();
        var devices = new Dictionary<string, BackendDevice> { ["nvenc"] = nvencDevice };
        if (vaapiNode is not null) devices["vaapi"] = vaapiDevice;

        foreach (var backend in HwBackends.Priority)
        {
            if (!HwBackends.SupportedOn(backend, os))
            {
                reports.Add(Unsupported(backend, $"{HwBackends.ShortName(backend)} is not available on {platformInfo.Os}"));
                continue;
            }
            if (!encodeResults.TryGetValue(backend, out var outcome))
            {
                reports.Add(Unsupported(backend, backend == "vaapi" ? "No DRM render node (/dev/dri/renderD*) found" : "Not tested"));
                continue;
            }
            var decoders = HwBackends.DecodeCodecs.ToDictionary(c => c, _ => "untested");
            var notes = new List<string>(outcome.Notes);
            string? deviceText = outcome.Device;
            switch (backend)
            {
                case "nvenc":
                    if (nvdec is { } n) { foreach (var (c, s) in n.Results) decoders[c] = s; notes.AddRange(n.Notes); }
                    else foreach (var c in HwBackends.DecodeCodecs) decoders[c] = "not-listed";
                    break;
                case "amf" or "qsv":
                {
                    var vendor = backend == "amf" ? "amd" : "intel";
                    (Dictionary<string, string> Results, List<string> Notes, string? Adapter)? d = null;
                    string? hwaccel = null;
                    IReadOnlyList<string> inputArgs = [];
                    if (d3dTasks.TryGetValue(vendor, out var dt))
                    {
                        d = dt.Result;
                        hwaccel = "d3d11va";
                        inputArgs = D3d11Args(backend, vendor, IntDevice(backend));
                    }
                    else if (vaapiTasks.TryGetValue(backend, out var vt))
                    {
                        d = vt.Result;
                        hwaccel = "vaapi";
                        inputArgs = ["-init_hw_device", $"vaapi=va:{linuxVaapiFor[backend]}", "-hwaccel", "vaapi", "-hwaccel_device", "va"];
                    }
                    if (d is { } dr)
                    {
                        foreach (var (c, s) in dr.Results) decoders[c] = s;
                        notes.AddRange(dr.Notes);
                        if (dr.Adapter is not null) deviceText = dr.Adapter;
                        var ok = dr.Results.Where(kv => kv.Value == "verified").Select(kv => kv.Key).ToHashSet();
                        if (ok.Count > 0)
                            decodePaths[backend] = new HwDecodePath
                            {
                                Hwaccel = hwaccel!, Label = hwaccel == "d3d11va" ? "D3D11VA" : "VAAPI",
                                InputArgs = inputArgs, Verified = ok, Adapter = dr.Adapter,
                            };
                    }
                    else if (os == HostOs.Windows && !hwaccels.Contains("d3d11va"))
                        foreach (var c in HwBackends.DecodeCodecs) decoders[c] = "not-listed";
                    if (!adapters.Any(a => a.Vendor == vendor && !a.Virtual) && adapters.Count > 0)
                        notes.Insert(0, $"No {GpuAdapterEnumerator.VendorLabel(vendor)} adapter found");
                    break;
                }
                case "vaapi":
                    if (vaapiTasks.TryGetValue("vaapi", out var vv))
                    {
                        var dr = vv.Result;
                        foreach (var (c, s) in dr.Results) decoders[c] = s;
                        notes.AddRange(dr.Notes);
                        var ok = dr.Results.Where(kv => kv.Value == "verified").Select(kv => kv.Key).ToHashSet();
                        if (ok.Count > 0)
                            decodePaths["vaapi"] = new HwDecodePath
                            {
                                Hwaccel = "vaapi", Label = "VAAPI", Verified = ok, Adapter = vaapiNode,
                                InputArgs = ["-hwaccel", "vaapi", "-hwaccel_device", "va"], // device comes from the backend's PreInputArgs
                            };
                    }
                    else if (!hwaccels.Contains("vaapi")) foreach (var c in HwBackends.DecodeCodecs) decoders[c] = "not-listed";
                    break;
                case "videotoolbox":
                    if (vtTask is not null)
                    {
                        var dr = vtTask.Result;
                        foreach (var (c, s) in dr.Results) decoders[c] = s;
                        notes.AddRange(dr.Notes);
                        var ok = dr.Results.Where(kv => kv.Value == "verified").Select(kv => kv.Key).ToHashSet();
                        if (ok.Count > 0)
                            decodePaths["videotoolbox"] = new HwDecodePath
                            {
                                Hwaccel = "videotoolbox", Label = "VideoToolbox", Verified = ok, InputArgs = ["-hwaccel", "videotoolbox"],
                            };
                    }
                    break;
            }
            var anyListed = outcome.Encoders.Values.Any(s => s != "not-listed");
            var status = outcome.Encoders.Values.Contains("verified") ? "verified" : anyListed ? "detected" : "unsupported";
            if (!anyListed) notes.Insert(0, $"This FFmpeg build has no {HwBackends.ShortName(backend)} encoders");
            reports.Add(new BackendReport
            {
                Id = backend, Label = HwBackends.Label(backend), Vendor = HwBackends.Vendor(backend), Kind = "encode+decode",
                Status = status, Encoders = outcome.Encoders, Decoders = decoders, Device = deviceText, Notes = notes,
            });
        }

        // D3D11VA: vendor-neutral Windows decode, paired with AMF/QSV encode.
        if (os != HostOs.Windows) reports.Add(Unsupported("d3d11va", $"D3D11VA is Windows-only"));
        else if (!hwaccels.Contains("d3d11va")) reports.Add(Unsupported("d3d11va", "This FFmpeg build does not list the d3d11va hwaccel"));
        else
        {
            var decoders = HwBackends.DecodeCodecs.ToDictionary(c => c, _ => "untested");
            var notes = new List<string>();
            var devicesTested = new List<string>();
            foreach (var (vendor, task) in d3dTasks)
            {
                var dr = task.Result;
                devicesTested.Add(dr.Adapter ?? GpuAdapterEnumerator.VendorLabel(vendor));
                foreach (var (c, s) in dr.Results)
                    if (decoders[c] != "verified" && (s != "untested" || decoders[c] == "untested")) decoders[c] = s;
                notes.Add($"{dr.Adapter ?? GpuAdapterEnumerator.VendorLabel(vendor)}: verified [{string.Join(", ", dr.Results.Where(kv => kv.Value == "verified").Select(kv => kv.Key))}]");
                notes.AddRange(dr.Notes);
            }
            if (d3dTasks.Count == 0) notes.Add("Not tested: no AMD or Intel adapter to pair with a hardware encoder (NVIDIA uses NVDEC)");
            reports.Add(new BackendReport
            {
                Id = "d3d11va", Label = HwBackends.Label("d3d11va"), Vendor = "other", Kind = "decode",
                Status = decoders.Values.Contains("verified") ? "verified" : "detected",
                Decoders = decoders, Device = devicesTested.Count > 0 ? string.Join("; ", devicesTested) : null, Notes = notes,
            });
        }

        var primary = PrimaryAdapter(adapters);
        var caps = new HardwareCapabilities
        {
            FfmpegAvailable = true,
            FfmpegVersion = ffmpegVersion,
            FfmpegPath = binaries.Ffmpeg,
            FfprobeAvailable = ffprobeOk,
            FfprobeVersion = ffprobeVer,
            FfprobePath = binaries.Ffprobe,
            Platform = platformInfo,
            GpuName = nvidia?.Name ?? primary?.Name,
            DriverVersion = nvidia?.Driver ?? primary?.Driver,
            GpuMemoryMiB = nvidia?.MemoryMiB ?? primary?.MemoryMiB,
            NvidiaSmiAvailable = smi.Count > 0,
            VerifiedEncoders = verifiedEncoders,
            VerifiedHardwareDecoders = verifiedNvdec,
            ListedHardwareDecoders = listedNvdec,
            LibplaceboTonemap = libplaceboTask.Result,
            CpuTonemap = Listed(filtersOut, "zscale") && Listed(filtersOut, "tonemap"),
            SoftwareEncoders = software,
            Adapters = adapters,
            Backends = reports,
            DecodePaths = decodePaths,
            Devices = devices,
            DetectionSeconds = Math.Round(sw.Elapsed.TotalSeconds, 2),
        };
        var selection = BackendSelector.Select(caps, options.HardwareAcceleration, options.HardwareDevice);
        logger.LogInformation(
            "Hardware: adapters=[{Adapters}] verified encoders=[{Enc}] nvdec=[{Dec}] decode paths=[{Paths}] libplacebo={Placebo} → {Effective} in {Sec}s",
            string.Join("; ", adapters.Select(a => a.Name + (a.Virtual ? " (virtual)" : ""))),
            string.Join(",", verifiedEncoders.Order()), string.Join(",", verifiedNvdec.Order()),
            string.Join("; ", decodePaths.Select(p => $"{p.Key}:{p.Value.Label}[{string.Join(",", p.Value.Verified.Order())}]")),
            caps.LibplaceboTonemap, selection.Effective, caps.DetectionSeconds);
        return caps;
    }

    private async Task<(List<GpuAdapter> Adapters, List<NvidiaSmiInfo> Smi)> DetectAdaptersAsync(CancellationToken ct)
    {
        var adapters = await GpuAdapterEnumerator.EnumerateAsync(runner, platform, ct);
        List<NvidiaSmiInfo> smi = [];
        // nvidia-smi only where an NVIDIA GPU can exist (or when enumeration told us nothing).
        if (platform.Os != HostOs.MacOS && (adapters.Count == 0 || adapters.Any(a => a.Vendor == "nvidia")))
            smi = await GpuAdapterEnumerator.NvidiaSmiAsync(runner, ct);
        return (GpuAdapterEnumerator.MergeNvidia(adapters, smi), smi);
    }

    private static GpuAdapter? PrimaryAdapter(List<GpuAdapter> adapters) =>
        adapters.Where(a => !a.Virtual).OrderBy(a => a.Vendor switch { "nvidia" => 0, "amd" => 1, "intel" => 2, "apple" => 3, _ => 4 }).FirstOrDefault();

    private static string? AdapterName(List<GpuAdapter> adapters, string vendor) =>
        adapters.FirstOrDefault(a => a.Vendor == vendor && !a.Virtual)?.Name;

    private static string CuvidName(string codec) => codec switch
    {
        "mpeg2video" => "mpeg2_cuvid",
        _ => codec + "_cuvid",
    };

    /// <summary>D3D11VA on a specific adapter: explicit index when configured, else the vendor's first adapter.</summary>
    public static string[] D3d11Args(string backend, string vendor, int? index)
    {
        var dev = index is { } i ? $"d3d11va=dx:{i.ToString(CultureInfo.InvariantCulture)}"
            : $"d3d11va=dx,vendor_id=0x{(vendor == "amd" ? "1002" : "8086")}";
        return ["-init_hw_device", dev, "-hwaccel", "d3d11va", "-hwaccel_device", "dx"];
    }

    private string? VaapiNode(string? configured, List<GpuAdapter> adapters, string? preferVendor)
    {
        if (configured is not null && configured.StartsWith("/dev/dri/", StringComparison.Ordinal)) return configured;
        var candidates = adapters.Where(a => !a.Virtual && a.RenderNode is not null).ToList();
        if (preferVendor is not null) return candidates.FirstOrDefault(a => a.Vendor == preferVendor)?.RenderNode;
        var node = candidates.OrderBy(a => a.Vendor switch { "intel" => 0, "amd" => 1, _ => 2 }).FirstOrDefault()?.RenderNode;
        if (node is not null) return node;
        return platform.Os == HostOs.Linux && platform.FileExists("/dev/dri/renderD128") ? "/dev/dri/renderD128" : null;
    }

    private static BackendReport Unsupported(string id, string note) => new()
    {
        Id = id,
        Label = HwBackends.Label(id),
        Vendor = HwBackends.Vendor(id),
        Kind = id == "d3d11va" ? "decode" : "encode+decode",
        Status = "unsupported",
        Encoders = id == "d3d11va" ? [] : HwBackends.EncodeCodecs.ToDictionary(c => c, _ => "not-listed"),
        Decoders = HwBackends.DecodeCodecs.ToDictionary(c => c, _ => "not-listed"),
        Notes = [note],
    };

    /// <summary>First meaningful stderr line, without object addresses, probe paths or URLs.</summary>
    public static string ShortReason(ProcessResult r, string? probeDir = null)
    {
        if (r.TimedOut) return "timed out";
        var lines = r.StdErr.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var line = lines.FirstOrDefault(l => Regex.IsMatch(l, "error|fail|cannot|could not|impossible|not supported|no device|invalid", RegexOptions.IgnoreCase))
                   ?? lines.FirstOrDefault() ?? $"exit code {r.ExitCode}";
        return Shorten(line, probeDir);
    }

    private static string Shorten(string text, string? probeDir = null)
    {
        var line = text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault() ?? "";
        line = Regex.Replace(line, @" @ (0x)?[0-9a-fA-F]{6,}\]", "]");
        if (!string.IsNullOrEmpty(probeDir)) line = line.Replace(probeDir, "<probe>", StringComparison.OrdinalIgnoreCase);
        line = MediaProber.Redact(line);
        return line.Length > 200 ? line[..200] + "…" : line;
    }
}

/// <summary>Detection runs once in the background at startup; callers await the shared task.</summary>
public sealed class HardwareCapabilitiesProvider(HardwareProbe probe)
{
    private Task<HardwareCapabilities>? _task;
    private readonly object _gate = new();

    public Task<HardwareCapabilities> GetAsync()
    {
        lock (_gate) return _task ??= probe.DetectAsync(CancellationToken.None);
    }

    public Task<HardwareCapabilities> RefreshAsync()
    {
        lock (_gate) return _task = probe.DetectAsync(CancellationToken.None);
    }

    /// <summary>The finished result, or null while detection is still running.</summary>
    public HardwareCapabilities? Current
    {
        get { lock (_gate) return _task is { IsCompletedSuccessfully: true } t ? t.Result : null; }
    }
}
