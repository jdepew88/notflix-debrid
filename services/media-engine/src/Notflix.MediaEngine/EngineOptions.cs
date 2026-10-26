namespace Notflix.MediaEngine;

/// <summary>
/// Runtime configuration. Defaults here and in appsettings.json ("Engine" section), then
/// {dataDir}/config/engine.json, then environment variables (see <see cref="EngineConfig"/>).
/// </summary>
public sealed class EngineOptions
{
    public const string Version = "1.0.0";
    public const int DefaultPort = 8421;
    public const long DefaultCacheMaxBytes = 10L * 1024 * 1024 * 1024;
    public const long MinCacheMaxBytes = 512L * 1024 * 1024;

    /// <summary>Interface to bind. Defaults to loopback so the engine stays private to the host.</summary>
    public string BindAddress { get; set; } = "127.0.0.1";
    public int Port { get; set; } = DefaultPort;

    /// <summary>Shared secret with the web app (service key + ticket HMAC key). Never logged.</summary>
    public string Secret { get; set; } = "";

    /// <summary>Notflix data directory (NOTFLIX_DATA_DIR or --data-dir); holds secrets/, config/, db/ and cache/.</summary>
    public string? DataDirectory { get; set; }

    public string? FfmpegPath { get; set; }
    public string? FfprobePath { get; set; }

    /// <summary>Root of everything the engine may write (default {data}/cache). Bounded by <see cref="CacheMaxBytes"/>.</summary>
    public string CacheDirectory { get; set; } = Path.Combine(Path.GetTempPath(), "notflix-media-cache");

    /// <summary>Engine scratch space for HLS segments ({cache}/engine). Each session gets its own subdirectory.</summary>
    public string TempDirectory { get; set; } = Path.Combine(Path.GetTempPath(), "notflix-media-cache", "engine");

    /// <summary>Upper bound for the engine scratch directory; the cache janitor enforces it.</summary>
    public long CacheMaxBytes { get; set; } = DefaultCacheMaxBytes;

    /// <summary>Hardware probe samples live under the scratch directory (never the system temp folder).</summary>
    public string HardwareProbeDirectory => Path.Combine(TempDirectory, CacheJanitorNames.ProbeDirectory);

    public int MaxConcurrentVideoTranscodes { get; set; } = 3;
    public int MaxConcurrentJobs { get; set; } = 10;

    /// <summary>Seconds of output the encoder may run ahead of the viewer before it is suspended.</summary>
    public int MaxAheadSeconds { get; set; } = 240;
    /// <summary>Segments older than this behind the viewer are deleted from disk.</summary>
    public int BackBufferSeconds { get; set; } = 600;
    public int SegmentSeconds { get; set; } = 4;

    /// <summary>Idle sessions (no requests) are torn down after this many seconds.</summary>
    public int SessionIdleSeconds { get; set; } = 900;
    public int ProbeTimeoutSeconds { get; set; } = 25;
    public int MaxSessionHours { get; set; } = 12;

    /// <summary>Host suffixes the engine may fetch over HTTPS (Real-Debrid CDN by default).</summary>
    public List<string> AllowedHostSuffixes { get; set; } =
        ["real-debrid.com", "download.real-debrid.com", "real-debrid.fr"];

    /// <summary>Exact hosts (e.g. a LAN media server) that may be fetched even when private. HTTP allowed.</summary>
    public List<string> AllowedPrivateHosts { get; set; } = [];

    /// <summary>Local directories files may be read from (local library, self-test samples).</summary>
    public List<string> LibraryRoots { get; set; } = [];

    /// <summary>"auto" (default), "nvenc", "qsv", "amf", "vaapi", "videotoolbox", or "off" (CPU only).</summary>
    public string HardwareAcceleration { get; set; } = "auto";

    /// <summary>
    /// Device for the explicitly selected backend: a GPU index for NVENC (-gpu N) or a D3D11 adapter
    /// index for AMF/QSV decode on Windows, or a render node (/dev/dri/renderD129) for VAAPI. Ignored for auto.
    /// </summary>
    public string? HardwareDevice { get; set; }

    /// <summary>Upper bound on transcode output height (user setting can lower it per session).</summary>
    public int MaxTranscodeHeight { get; set; } = 2160;
}

public static class CacheJanitorNames
{
    public const string Marker = ".notflix-cache";
    public const string ProbeDirectory = ".hwprobe";
}
