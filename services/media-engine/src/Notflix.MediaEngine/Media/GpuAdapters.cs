using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Notflix.MediaEngine.Processes;

namespace Notflix.MediaEngine.Media;

/// <summary>A display adapter the OS reports. Presence says nothing about what FFmpeg can use on it.</summary>
public sealed record GpuAdapter
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    /// <summary>"nvidia", "intel", "amd", "apple", "other".</summary>
    public required string Vendor { get; init; }
    public string? Driver { get; init; }
    /// <summary>Virtual / remote-display / basic-render adapters (Parsec, RDP, Hyper-V, VM GPUs).</summary>
    public bool Virtual { get; init; }
    public long? MemoryMiB { get; init; }
    /// <summary>PCI vendor id in lower-case hex without prefix ("10de"), when known.</summary>
    public string? PciVendorId { get; init; }
    /// <summary>Linux DRM render node (/dev/dri/renderD128), when known.</summary>
    public string? RenderNode { get; init; }
    /// <summary>nvidia-smi / CUDA index, when this is an NVIDIA adapter seen by nvidia-smi.</summary>
    public int? NvidiaIndex { get; init; }
}

public sealed record NvidiaSmiInfo(int Index, string Name, string Driver, long? MemoryMiB);

/// <summary>Enumerates display adapters per OS (CIM on Windows, sysfs on Linux, system_profiler on macOS).</summary>
public static class GpuAdapterEnumerator
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);

    public static string VendorFromPciId(string? id) => (id ?? "").Trim().ToLowerInvariant().Replace("0x", "") switch
    {
        "10de" => "nvidia",
        "8086" => "intel",
        "1002" or "1022" => "amd",
        "106b" => "apple",
        _ => "other",
    };

    private static readonly string[] VirtualMarkers =
        ["virtual", "parsec", "microsoft basic", "remote display", "hyper-v", "vmware", "virtualbox", "citrix", "spacedesk"];

    public static bool LooksVirtual(string? name, string? pnpId)
    {
        if (pnpId is not null && pnpId.StartsWith(@"ROOT\", StringComparison.OrdinalIgnoreCase)) return true;
        var n = (name ?? "").ToLowerInvariant();
        return VirtualMarkers.Any(n.Contains);
    }

    public static async Task<List<GpuAdapter>> EnumerateAsync(IProcessRunner runner, IHostPlatform platform, CancellationToken ct)
    {
        try
        {
            return platform.Os switch
            {
                HostOs.Windows => await WindowsAsync(runner, ct),
                HostOs.Linux => Linux(platform),
                HostOs.MacOS => await MacAsync(runner, ct),
                _ => [],
            };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return [];
        }
    }

    private static async Task<List<GpuAdapter>> WindowsAsync(IProcessRunner runner, CancellationToken ct)
    {
        var r = await runner.RunAsync("powershell",
            ["-NoProfile", "-NonInteractive", "-Command",
             "Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID,DriverVersion,AdapterRAM | ConvertTo-Json -Compress"],
            Timeout, ct);
        return r.ExitCode == 0 ? ParseWindows(r.StdOut) : [];
    }

    public static List<GpuAdapter> ParseWindows(string json)
    {
        var list = new List<GpuAdapter>();
        if (string.IsNullOrWhiteSpace(json)) return list;
        using var doc = JsonDocument.Parse(json);
        var items = doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement.EnumerateArray().ToList() : [doc.RootElement];
        foreach (var item in items)
        {
            string? Str(string name) => item.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            var name = Str("Name") ?? "Unknown adapter";
            var pnp = Str("PNPDeviceID");
            var ven = pnp is null ? "" : Regex.Match(pnp, @"VEN_([0-9A-Fa-f]{4})").Groups[1].Value;
            long? mem = item.TryGetProperty("AdapterRAM", out var ram) && ram.ValueKind == JsonValueKind.Number && ram.TryGetInt64(out var bytes) && bytes > 0
                ? bytes / 1048576 : null;
            list.Add(new GpuAdapter
            {
                Id = $"gpu{list.Count}",
                Name = name,
                Vendor = ven.Length == 0 ? VendorFromName(name) : VendorFromPciId(ven),
                Driver = Str("DriverVersion"),
                Virtual = LooksVirtual(name, pnp),
                MemoryMiB = mem,
                PciVendorId = ven.Length == 0 ? null : ven.ToLowerInvariant(),
            });
        }
        return list;
    }

    private static List<GpuAdapter> Linux(IHostPlatform platform)
    {
        var list = new List<GpuAdapter>();
        var cards = platform.EnumerateDirectories("/sys/class/drm", "card*")
            .Select(d => d.Replace('\\', '/'))
            .Where(d => Regex.IsMatch(Path.GetFileName(d), @"^card\d+$"))
            .OrderBy(d => int.Parse(Path.GetFileName(d)[4..], CultureInfo.InvariantCulture));
        foreach (var card in cards)
        {
            var dev = card + "/device";
            var ven = platform.ReadText(dev + "/vendor")?.Trim().ToLowerInvariant().Replace("0x", "");
            var devId = platform.ReadText(dev + "/device")?.Trim().ToLowerInvariant().Replace("0x", "");
            var uevent = platform.ReadText(dev + "/uevent") ?? "";
            var driver = Regex.Match(uevent, @"^DRIVER=(.+)$", RegexOptions.Multiline).Groups[1].Value.Trim();
            var render = platform.EnumerateDirectories(dev + "/drm", "renderD*")
                .Select(p => Path.GetFileName(p.Replace('\\', '/'))).FirstOrDefault();
            var vendor = VendorFromPciId(ven);
            var isVirtual = ven is "1af4" or "15ad" or "1234" or "1b36" or "80ee" ||
                            driver is "virtio-pci" or "virtio_gpu" or "vmwgfx" or "bochs-drm" or "qxl";
            list.Add(new GpuAdapter
            {
                Id = Path.GetFileName(card),
                Name = $"{VendorLabel(vendor)} GPU ({ven ?? "?"}:{devId ?? "?"})",
                Vendor = vendor,
                Driver = driver.Length == 0 ? null : driver,
                Virtual = isVirtual,
                PciVendorId = ven,
                RenderNode = render is null ? null : "/dev/dri/" + render,
            });
        }
        return list;
    }

    private static async Task<List<GpuAdapter>> MacAsync(IProcessRunner runner, CancellationToken ct)
    {
        var r = await runner.RunAsync("system_profiler", ["SPDisplaysDataType", "-json"], Timeout, ct);
        return r.ExitCode == 0 ? ParseMac(r.StdOut) : [];
    }

    public static List<GpuAdapter> ParseMac(string json)
    {
        var list = new List<GpuAdapter>();
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("SPDisplaysDataType", out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
        foreach (var item in arr.EnumerateArray())
        {
            string? Str(string name) => item.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            var name = Str("sppci_model") ?? Str("_name") ?? "Display adapter";
            var vendorRaw = (Str("spdisplays_vendor") ?? "") + " " + name;
            var vram = Str("spdisplays_vram") ?? Str("spdisplays_vram_shared");
            long? mem = null;
            if (vram is not null && Regex.Match(vram, @"(\d+)\s*(GB|MB)", RegexOptions.IgnoreCase) is { Success: true } m)
                mem = long.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) * (m.Groups[2].Value.Equals("GB", StringComparison.OrdinalIgnoreCase) ? 1024 : 1);
            list.Add(new GpuAdapter
            {
                Id = $"display{list.Count}",
                Name = name,
                Vendor = VendorFromName(vendorRaw),
                Virtual = LooksVirtual(name, null),
                MemoryMiB = mem,
            });
        }
        return list;
    }

    public static string VendorFromName(string name)
    {
        var n = name.ToLowerInvariant();
        if (n.Contains("nvidia")) return "nvidia";
        if (n.Contains("intel")) return "intel";
        if (n.Contains("amd") || n.Contains("radeon") || n.Contains("advanced micro")) return "amd";
        if (n.Contains("apple")) return "apple";
        return "other";
    }

    public static string VendorLabel(string vendor) => vendor switch
    {
        "nvidia" => "NVIDIA",
        "intel" => "Intel",
        "amd" => "AMD",
        "apple" => "Apple",
        _ => "Unknown",
    };

    public static async Task<List<NvidiaSmiInfo>> NvidiaSmiAsync(IProcessRunner runner, CancellationToken ct)
    {
        var smi = await runner.RunAsync("nvidia-smi",
            ["--query-gpu=index,name,driver_version,memory.total", "--format=csv,noheader,nounits"], Timeout, ct);
        if (smi.ExitCode != 0) return [];
        var list = new List<NvidiaSmiInfo>();
        foreach (var line in smi.StdOut.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var p = line.Split(',').Select(x => x.Trim()).ToArray();
            if (p.Length < 4 || !int.TryParse(p[0], out var idx)) continue;
            list.Add(new NvidiaSmiInfo(idx, p[1], p[2], long.TryParse(p[3], out var mem) ? mem : null));
        }
        return list;
    }

    /// <summary>Adds nvidia-smi's name/driver/memory/index to the NVIDIA adapters (in order); adds any it missed.</summary>
    public static List<GpuAdapter> MergeNvidia(List<GpuAdapter> adapters, List<NvidiaSmiInfo> smi)
    {
        if (smi.Count == 0) return adapters;
        var result = new List<GpuAdapter>(adapters);
        var queue = new Queue<NvidiaSmiInfo>(smi);
        for (var i = 0; i < result.Count && queue.Count > 0; i++)
        {
            if (result[i].Vendor != "nvidia" || result[i].Virtual) continue;
            var s = queue.Dequeue();
            result[i] = result[i] with { Name = s.Name, Driver = s.Driver, MemoryMiB = s.MemoryMiB ?? result[i].MemoryMiB, NvidiaIndex = s.Index };
        }
        foreach (var s in queue)
            result.Add(new GpuAdapter
            {
                Id = $"nvidia{s.Index}", Name = s.Name, Vendor = "nvidia", Driver = s.Driver, MemoryMiB = s.MemoryMiB,
                NvidiaIndex = s.Index, PciVendorId = "10de",
            });
        return result;
    }
}
