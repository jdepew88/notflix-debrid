using System.Globalization;
using System.Runtime.InteropServices;
using Notflix.MediaEngine.Media;
using Notflix.MediaEngine.Processes;

namespace Notflix.MediaEngine.Monitoring;

/// <summary>GPU-wide sample from nvidia-smi. Encoder/decoder figures are the dedicated NVENC/NVDEC engines.</summary>
public sealed record GpuSample(
    DateTimeOffset At,
    double? GpuPercent,
    double? EncoderPercent,
    double? DecoderPercent,
    double? MemoryUsedMiB,
    double? MemoryTotalMiB,
    double? TemperatureC,
    double? PowerW);

/// <summary>
/// Samples nvidia-smi once per second while any video job is active (and every 15 s otherwise) — only on
/// hosts where detection found NVIDIA's tool — and the system CPU (GetSystemTimes on Windows,
/// /proc/stat on Linux, unavailable elsewhere). Keeps per-job peaks so diagnostics can prove the GPU
/// engines were busy, not just configured.
/// </summary>
public sealed partial class SystemMonitor : BackgroundService
{
    private readonly ILogger<SystemMonitor> _logger;
    private readonly HardwareCapabilitiesProvider _hardware;
    private readonly object _gate = new();
    private GpuSample? _lastGpu;
    private double? _cpuPercent;
    private (ulong idle, ulong total)? _lastCpuTimes;
    private bool _nvidiaSmiMissing;
    private int _activeVideoJobs;

    public SystemMonitor(ILogger<SystemMonitor> logger, HardwareCapabilitiesProvider hardware)
    {
        _logger = logger;
        _hardware = hardware;
    }

    public GpuSample? LatestGpu { get { lock (_gate) return _lastGpu; } }
    public double? CpuPercent { get { lock (_gate) return _cpuPercent; } }
    /// <summary>GPU utilization counters exist (NVIDIA with nvidia-smi). Other vendors report none.</summary>
    public bool GpuMonitoringAvailable => !_nvidiaSmiMissing && _hardware.Current?.NvidiaSmiAvailable == true;

    public event Action<GpuSample>? GpuSampled;

    public void VideoJobStarted() => Interlocked.Increment(ref _activeVideoJobs);
    public void VideoJobStopped() => Interlocked.Decrement(ref _activeVideoJobs);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var lastGpuAt = DateTimeOffset.MinValue;
        while (!stoppingToken.IsCancellationRequested)
        {
            SampleCpu();
            var busy = Volatile.Read(ref _activeVideoJobs) > 0;
            var interval = busy ? TimeSpan.FromSeconds(1) : TimeSpan.FromSeconds(15);
            if (GpuMonitoringAvailable && DateTimeOffset.UtcNow - lastGpuAt >= interval)
            {
                await SampleGpuAsync(stoppingToken);
                lastGpuAt = DateTimeOffset.UtcNow;
            }
            try { await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task SampleGpuAsync(CancellationToken ct)
    {
        var r = await ProcessRunner.RunAsync("nvidia-smi",
            ["--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw",
             "--format=csv,noheader,nounits"], TimeSpan.FromSeconds(5), ct);
        if (r.ExitCode != 0)
        {
            if (r.StartFailed)
            {
                _nvidiaSmiMissing = true;
                _logger.LogInformation("nvidia-smi unavailable; GPU utilization will be reported as unavailable");
            }
            return;
        }
        var line = r.StdOut.Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        if (line is null) return;
        var p = line.Split(',').Select(s => s.Trim()).ToArray();
        double? D(int i) => i < p.Length && double.TryParse(p[i], NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : null;
        var sample = new GpuSample(DateTimeOffset.UtcNow, D(0), D(1), D(2), D(3), D(4), D(5), D(6));
        lock (_gate) _lastGpu = sample;
        GpuSampled?.Invoke(sample);
    }

    private void SampleCpu()
    {
        (ulong idle, ulong total)? now = null;
        if (OperatingSystem.IsWindows())
        {
            if (GetSystemTimes(out var idleFt, out var kernelFt, out var userFt))
                now = (ToUlong(idleFt), ToUlong(kernelFt) + ToUlong(userFt)); // kernel time includes idle
        }
        else if (OperatingSystem.IsLinux())
        {
            now = ParseProcStat(ReadProcStat());
        }
        if (now is not { } n) return;
        lock (_gate)
        {
            if (_lastCpuTimes is { } prev && n.total > prev.total)
            {
                var idle = n.idle - prev.idle;
                var total = n.total - prev.total;
                _cpuPercent = Math.Round(100.0 * (total - Math.Min(idle, total)) / total, 1);
            }
            _lastCpuTimes = n;
        }
    }

    private static string? ReadProcStat()
    {
        try { return File.ReadLines("/proc/stat").FirstOrDefault(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    /// <summary>Aggregate "cpu" line of /proc/stat → (idle+iowait, total) jiffies.</summary>
    public static (ulong idle, ulong total)? ParseProcStat(string? line)
    {
        if (line is null || !line.StartsWith("cpu ", StringComparison.Ordinal)) return null;
        var v = line.Split(' ', StringSplitOptions.RemoveEmptyEntries).Skip(1)
            .Select(x => ulong.TryParse(x, NumberStyles.None, CultureInfo.InvariantCulture, out var u) ? u : 0UL).ToArray();
        if (v.Length < 4) return null;
        var total = v.Take(8).Aggregate(0UL, (a, b) => a + b); // user nice system idle iowait irq softirq steal
        var idle = v[3] + (v.Length > 4 ? v[4] : 0);
        return (idle, total);
    }

    private static ulong ToUlong(FILETIME ft) => ((ulong)ft.dwHighDateTime << 32) | ft.dwLowDateTime;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME { public uint dwLowDateTime; public uint dwHighDateTime; }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetSystemTimes(out FILETIME idle, out FILETIME kernel, out FILETIME user);
}
