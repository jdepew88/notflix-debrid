using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Notflix.MediaEngine.Api;
using Notflix.MediaEngine.Media;
using Notflix.MediaEngine.Monitoring;
using Notflix.MediaEngine.Playback;

namespace Notflix.MediaEngine.Tests;

/// <summary>Creates and removes a scratch folder (under the system temp dir) per test.</summary>
public sealed class TempDir : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "notflix-test-" + Guid.NewGuid().ToString("N")[..10]);
    public TempDir() => Directory.CreateDirectory(Path);
    public string Sub(params string[] parts) => System.IO.Path.Combine([Path, .. parts]);

    public void Dispose()
    {
        try { Directory.Delete(Path, true); } catch { /* best effort */ }
    }
}

public class EngineConfigTests
{
    private const string Secret = "0123456789abcdef0123456789abcdef0123456789ab"; // test-only value

    private static Func<string, string?> Env(params (string Key, string Value)[] vars) =>
        key => vars.FirstOrDefault(v => v.Key == key).Value;

    private static string DataDir(TempDir tmp, string? secret = Secret, string? json = null)
    {
        var data = tmp.Sub("data");
        Directory.CreateDirectory(System.IO.Path.Combine(data, "secrets"));
        Directory.CreateDirectory(System.IO.Path.Combine(data, "config"));
        if (secret is not null) File.WriteAllText(EngineConfig.SecretPath(data), secret + "\n");
        if (json is not null) File.WriteAllText(EngineConfig.ConfigPath(data), json);
        return data;
    }

    [Fact]
    public void DataDir_SecretFileAndDefaults()
    {
        using var tmp = new TempDir();
        var data = DataDir(tmp);
        var o = new EngineOptions();
        EngineConfig.Load(o, data, Env());
        Assert.Equal(Secret, o.Secret);
        Assert.Equal(8421, o.Port);
        Assert.Equal("127.0.0.1", o.BindAddress);
        Assert.Equal(System.IO.Path.Combine(data, "cache"), o.CacheDirectory);
        Assert.Equal(System.IO.Path.Combine(data, "cache", "engine"), o.TempDirectory);
        Assert.Equal(10L * 1024 * 1024 * 1024, o.CacheMaxBytes);
        Assert.StartsWith(o.TempDirectory, o.HardwareProbeDirectory); // probe samples stay inside the cache
    }

    [Fact]
    public void EngineJson_IsApplied_AndEnvironmentOverrides()
    {
        using var tmp = new TempDir();
        var cache = tmp.Sub("elsewhere", "cache");
        var data = DataDir(tmp, json: $$"""
            { "port": 8500, "bindAddress": "0.0.0.0", "cacheDirectory": {{System.Text.Json.JsonSerializer.Serialize(cache)}},
              "cacheMaxBytes": 1073741824, "hardwareAcceleration": "amf", "hardwareDevice": null,
              "maxConcurrentVideoTranscodes": 2, "maxTranscodeHeight": 1080, "ffmpegPath": null,
              "libraryRoots": ["D:/Movies"], "allowedPrivateHosts": ["192.0.2.10"], "someFutureField": true, }
            """);
        var o = new EngineOptions();
        EngineConfig.Load(o, data, Env(("MEDIA_ENGINE_PORT", "8600"), ("MEDIA_ENGINE_HWACCEL", "off")));
        Assert.Equal(8600, o.Port);                // env wins
        Assert.Equal("off", o.HardwareAcceleration); // env wins
        Assert.Equal("0.0.0.0", o.BindAddress);
        Assert.Equal(cache, o.CacheDirectory);
        Assert.Equal(System.IO.Path.Combine(cache, "engine"), o.TempDirectory);
        Assert.Equal(1073741824, o.CacheMaxBytes);
        Assert.Equal(2, o.MaxConcurrentVideoTranscodes);
        Assert.Equal(1080, o.MaxTranscodeHeight);
        Assert.Contains("D:/Movies", o.LibraryRoots);
        Assert.Contains("192.0.2.10", o.AllowedPrivateHosts);
    }

    [Fact]
    public void EnvSecret_OverridesFile_AndIsNeverInErrors()
    {
        using var tmp = new TempDir();
        var data = DataDir(tmp);
        var o = new EngineOptions();
        var envSecret = new string('z', 40);
        EngineConfig.Load(o, data, Env(("MEDIA_ENGINE_SECRET", envSecret)));
        Assert.Equal(envSecret, o.Secret);

        using var tmp2 = new TempDir();
        var shortFile = DataDir(tmp2, secret: "too-short-secret");
        var ex = Assert.Throws<EngineConfigException>(() => EngineConfig.Load(new EngineOptions(), shortFile, Env()));
        Assert.Contains("shorter than 32", ex.Message);
        Assert.DoesNotContain("too-short-secret", ex.Message);
    }

    [Fact]
    public void MissingSecret_NamesTheExpectedFile()
    {
        using var tmp = new TempDir();
        var data = DataDir(tmp, secret: null);
        var ex = Assert.Throws<EngineConfigException>(() => EngineConfig.Load(new EngineOptions(), data, Env()));
        Assert.Contains(EngineConfig.SecretPath(data), ex.Message);

        var noData = Assert.Throws<EngineConfigException>(() => EngineConfig.Load(new EngineOptions(), null, Env()));
        Assert.Contains("NOTFLIX_DATA_DIR", noData.Message);
    }

    [Fact]
    public void DataDir_FromEnvironmentOrArgs()
    {
        using var tmp = new TempDir();
        var data = DataDir(tmp);
        var o = new EngineOptions();
        EngineConfig.Load(o, null, Env(("NOTFLIX_DATA_DIR", data)));
        Assert.Equal(data, o.DataDirectory);
        Assert.Equal("/x/y", EngineConfig.DataDirFromArgs(["--urls", "a", "--data-dir", "/x/y"]));
        Assert.Equal("/x/z", EngineConfig.DataDirFromArgs(["--data-dir=/x/z"]));
        Assert.Null(EngineConfig.DataDirFromArgs([]));
    }

    [Fact]
    public void InvalidEngineJson_IsAReadableError()
    {
        using var tmp = new TempDir();
        var bad = DataDir(tmp, json: "{ \"port\": \"eighty\" }");
        Assert.Contains("\"port\" must be", Assert.Throws<EngineConfigException>(() => EngineConfig.Load(new EngineOptions(), bad, Env())).Message);
        using var tmp2 = new TempDir();
        var hw = DataDir(tmp2, json: "{ \"hardwareAcceleration\": \"cuda\" }");
        Assert.Contains("must be one of", Assert.Throws<EngineConfigException>(() => EngineConfig.Load(new EngineOptions(), hw, Env())).Message);
        using var tmp3 = new TempDir();
        var broken = DataDir(tmp3, json: "{ not json");
        Assert.Contains("not valid JSON", Assert.Throws<EngineConfigException>(() => EngineConfig.Load(new EngineOptions(), broken, Env())).Message);
    }

    [Fact]
    public void CacheDirectory_MayNotBeRootOrContainDataFolders()
    {
        using var tmp = new TempDir();
        var root = System.IO.Path.GetPathRoot(tmp.Path)!;
        var rootJson = DataDir(tmp, json: $$"""{ "cacheDirectory": {{System.Text.Json.JsonSerializer.Serialize(root)}} }""");
        Assert.Contains("filesystem root", Assert.Throws<EngineConfigException>(() => EngineConfig.Load(new EngineOptions(), rootJson, Env())).Message);

        using var tmp2 = new TempDir();
        var data = tmp2.Sub("data");
        var dataJson = DataDir(tmp2, json: $$"""{ "cacheDirectory": {{System.Text.Json.JsonSerializer.Serialize(data)}} }""");
        Assert.Contains("would contain", Assert.Throws<EngineConfigException>(() => EngineConfig.Load(new EngineOptions(), dataJson, Env())).Message);

        using var tmp3 = new TempDir();
        var secrets = DataDir(tmp3, json: """{ "cacheDirectory": "secrets" }""");
        Assert.Throws<EngineConfigException>(() => EngineConfig.Load(new EngineOptions(), secrets, Env()));

        using var tmp4 = new TempDir();
        var tempOverride = DataDir(tmp4);
        Assert.Throws<EngineConfigException>(() => EngineConfig.Load(new EngineOptions(), tempOverride,
            Env(("MEDIA_ENGINE_TEMP_DIR", System.IO.Path.Combine(tempOverride, "config")))));
    }

    [Fact]
    public void PathHelpers()
    {
        var baseDir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "a");
        Assert.True(EngineConfig.IsSameOrAncestor(baseDir, System.IO.Path.Combine(baseDir, "b", "c")));
        Assert.False(EngineConfig.IsSameOrAncestor(System.IO.Path.Combine(baseDir, "b"), System.IO.Path.Combine(baseDir, "bc")));
        Assert.True(EngineConfig.IsStrictlyInside(System.IO.Path.Combine(baseDir, "b"), baseDir));
        Assert.False(EngineConfig.IsStrictlyInside(baseDir, baseDir));
        Assert.True(EngineConfig.IsFilesystemRoot(System.IO.Path.GetPathRoot(baseDir)!));
    }
}

public class RuntimeConfigTests
{
    [Fact]
    public void ParsesNewFields_AndDistinguishesNullFromAbsent()
    {
        var req = RuntimeConfigRequest.Parse(JsonNode.Parse("""{"hardwareAcceleration":"AMF","hardwareDevice":null,"cacheMaxBytes":1073741824,"maxTranscodeHeight":1080}""")!.AsObject());
        Assert.Equal("amf", req.HardwareAcceleration);
        Assert.True(req.HardwareDeviceSpecified);
        Assert.Null(req.HardwareDevice);
        Assert.Equal(1073741824, req.CacheMaxBytes);
        Assert.Equal(1080, req.MaxTranscodeHeight);
        var absent = RuntimeConfigRequest.Parse(JsonNode.Parse("""{"maxConcurrentVideoTranscodes":2}""")!.AsObject());
        Assert.False(absent.HardwareDeviceSpecified);
        Assert.Equal("/dev/dri/renderD129", RuntimeConfigRequest.Parse(JsonNode.Parse("""{"hardwareDevice":"/dev/dri/renderD129"}""")!.AsObject()).HardwareDevice);
    }

    [Theory]
    [InlineData("""{"hardwareAcceleration":"cuda"}""")]
    [InlineData("""{"hardwareDevice":"0; rm -rf /"}""")]
    [InlineData("""{"hardwareDevice":5}""")]
    [InlineData("""{"cacheMaxBytes":1024}""")]
    public void RejectsInvalidValues(string json) =>
        Assert.Throws<ArgumentException>(() => RuntimeConfigRequest.Parse(JsonNode.Parse(json)!.AsObject()));
}

public class FfmpegLocatorTests
{
    [Fact]
    public void MissingFfmpeg_IsReportedNotThrown()
    {
        var b = FfmpegLocator.Locate(null, null, HostOs.Linux, _ => "/usr/sbin:/opt/none", _ => false, _ => false, (_, _) => []);
        Assert.False(b.FfmpegFound);
        Assert.False(b.Found);
        Assert.Equal("ffmpeg", b.Ffmpeg);
    }

    [Fact]
    public void FindsUsrBinOnLinux_AndHomebrewOnMac()
    {
        var linux = FfmpegLocator.Locate(null, null, HostOs.Linux, _ => null, p => p.Replace('\\', '/') is "/usr/bin/ffmpeg" or "/usr/bin/ffprobe", _ => false, (_, _) => []);
        Assert.True(linux.Found);
        Assert.Equal("/usr/bin/ffmpeg", linux.Ffmpeg.Replace('\\', '/'));
        var mac = FfmpegLocator.Locate(null, null, HostOs.MacOS, _ => null, p => p.Replace('\\', '/').StartsWith("/opt/homebrew/bin/"), _ => false, (_, _) => []);
        Assert.Equal("/opt/homebrew/bin/ffmpeg", mac.Ffmpeg.Replace('\\', '/'));
    }

    [Fact]
    public void ExplicitPath_IsUsed_AndChecked()
    {
        var b = FfmpegLocator.Locate("/opt/ff/ffmpeg", null, HostOs.Linux, _ => null, p => p.Replace('\\', '/') == "/opt/ff/ffmpeg", _ => false, (_, _) => []);
        Assert.True(b.FfmpegFound);
        Assert.False(b.FfprobeFound);
        Assert.Equal("/opt/ff/ffprobe", b.Ffprobe.Replace('\\', '/'));
    }
}

public class CacheJanitorTests
{
    private sealed class FakeSessions(params string[] active) : ICacheSessions
    {
        public long Evicted { get; private set; }
        public long EvictBehindViewerResult { get; init; }
        public bool IsActiveSessionDirectory(string name) => active.Contains(name);
        public long EvictBehindViewer(long bytesWanted) { Evicted += bytesWanted; return EvictBehindViewerResult; }
    }

    private static (CacheJanitor Janitor, EngineOptions Options) Make(TempDir tmp, ICacheSessions sessions, long max = EngineOptions.MinCacheMaxBytes)
    {
        var o = new EngineOptions { CacheDirectory = tmp.Sub("cache"), TempDirectory = tmp.Sub("cache", "engine"), CacheMaxBytes = max };
        return (new CacheJanitor(o, sessions, NullLogger<CacheJanitor>.Instance), o);
    }

    private static void WriteFile(string path, int bytes)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, new byte[bytes]);
    }

    [Fact]
    public void Initialize_WritesMarker_AndRemovesOrphansOnly()
    {
        using var tmp = new TempDir();
        var (janitor, o) = Make(tmp, new FakeSessions("live01"));
        WriteFile(System.IO.Path.Combine(o.TempDirectory, "orphan1", "g1", "seg_00000.m4s"), 100);
        WriteFile(System.IO.Path.Combine(o.TempDirectory, "live01", "g1", "seg_00000.m4s"), 100);
        WriteFile(System.IO.Path.Combine(o.TempDirectory, "stray.txt"), 10);
        var removed = janitor.Initialize();
        Assert.Equal(1, removed);
        Assert.True(File.Exists(System.IO.Path.Combine(o.CacheDirectory, CacheJanitorNames.Marker)));
        Assert.False(Directory.Exists(System.IO.Path.Combine(o.TempDirectory, "orphan1")));
        Assert.True(Directory.Exists(System.IO.Path.Combine(o.TempDirectory, "live01")));
        Assert.True(File.Exists(System.IO.Path.Combine(o.TempDirectory, "stray.txt")));
    }

    [Fact]
    public void Sweep_OverLimit_DeletesInactiveSessionsFirst_ThenEvictsBehindViewer()
    {
        using var tmp = new TempDir();
        var sessions = new FakeSessions("live01") { EvictBehindViewerResult = 0 };
        var (janitor, o) = Make(tmp, sessions, max: 1000);
        janitor.Initialize();
        WriteFile(System.IO.Path.Combine(o.TempDirectory, "gone01", "g1", "seg_00000.m4s"), 1500);
        WriteFile(System.IO.Path.Combine(o.TempDirectory, "live01", "g1", "seg_00000.m4s"), 600);
        var sweep = janitor.Sweep();
        Assert.Equal(2100, sweep.UsedBytesBefore);
        Assert.Equal(1, sweep.DirectoriesRemoved);
        Assert.Equal(600, sweep.UsedBytesAfter);
        Assert.Equal(0, sessions.Evicted); // back under the limit without touching the live session
        Assert.True(File.Exists(System.IO.Path.Combine(o.TempDirectory, "live01", "g1", "seg_00000.m4s")));

        WriteFile(System.IO.Path.Combine(o.TempDirectory, "live01", "g1", "seg_00001.m4s"), 900);
        janitor.Sweep();
        Assert.Equal(500, sessions.Evicted); // asked live sessions for exactly the overage
    }

    [Fact]
    public void Sweep_UnderLimit_KeepsRecentInactiveDirectories()
    {
        using var tmp = new TempDir();
        var (janitor, o) = Make(tmp, new FakeSessions(), max: EngineOptions.MinCacheMaxBytes);
        janitor.Initialize();
        WriteFile(System.IO.Path.Combine(o.TempDirectory, "just-closed", "sub_2_0.vtt"), 10);
        Assert.Equal(0, janitor.Sweep().DirectoriesRemoved); // inside the grace period
    }

    [Fact]
    public void DeleteTree_RefusesAnythingOutsideTheEngineRoot()
    {
        using var tmp = new TempDir();
        var (janitor, o) = Make(tmp, new FakeSessions());
        janitor.Initialize();
        var outside = tmp.Sub("outside");
        WriteFile(System.IO.Path.Combine(outside, "keep.bin"), 10);
        Assert.False(janitor.DeleteTree(outside));
        Assert.False(janitor.DeleteTree(o.TempDirectory));                                   // the root itself
        Assert.False(janitor.DeleteTree(System.IO.Path.Combine(o.TempDirectory, "..", "..", "outside"))); // traversal
        Assert.False(janitor.DeleteTree(o.CacheDirectory));                                  // the parent
        Assert.True(File.Exists(System.IO.Path.Combine(outside, "keep.bin")));
    }

    [Fact]
    public void DeleteTree_NeverFollowsLinksOutOfTheRoot()
    {
        using var tmp = new TempDir();
        var (janitor, o) = Make(tmp, new FakeSessions());
        janitor.Initialize();
        var outside = tmp.Sub("precious");
        WriteFile(System.IO.Path.Combine(outside, "family-photo.jpg"), 10);
        var session = System.IO.Path.Combine(o.TempDirectory, "evil01");
        Directory.CreateDirectory(session);
        var link = System.IO.Path.Combine(session, "link");
        try
        {
            Directory.CreateSymbolicLink(link, outside);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Symlinks need Developer Mode/admin on Windows; a junction (also a reparse point) does not.
            Assert.True(OperatingSystem.IsWindows(), "could not create a symlink: " + ex.Message);
            var psi = new System.Diagnostics.ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
            foreach (var a in new[] { "/c", "mklink", "/J", link, outside }) psi.ArgumentList.Add(a);
            using var p = System.Diagnostics.Process.Start(psi)!;
            p.WaitForExit(10_000);
            Assert.True(Directory.Exists(System.IO.Path.Combine(link)), "junction was not created");
        }
        Assert.True(File.Exists(System.IO.Path.Combine(link, "family-photo.jpg"))); // the link really points outside
        Assert.Equal(0, CacheJanitor.DirectorySize(session)); // links are not counted either
        Assert.True(janitor.DeleteTree(session));
        Assert.False(Directory.Exists(session));
        Assert.True(File.Exists(System.IO.Path.Combine(outside, "family-photo.jpg")));
    }

    [Fact]
    public void DataDirectory_IsNeverACacheRoot()
    {
        using var tmp = new TempDir();
        var data = tmp.Sub("data");
        Directory.CreateDirectory(System.IO.Path.Combine(data, "db"));
        var o = new EngineOptions { DataDirectory = data, CacheDirectory = data, TempDirectory = System.IO.Path.Combine(data, "engine") };
        Assert.Throws<EngineConfigException>(() => EngineConfig.ValidateCacheLocation(o));
        o.CacheDirectory = System.IO.Path.Combine(data, "cache");
        o.TempDirectory = System.IO.Path.Combine(data, "cache", "engine");
        EngineConfig.ValidateCacheLocation(o); // the default layout is fine
        var rootJanitor = new CacheJanitor(new EngineOptions { CacheDirectory = tmp.Path, TempDirectory = System.IO.Path.GetPathRoot(tmp.Path)! },
            new FakeSessions(), NullLogger<CacheJanitor>.Instance);
        Assert.Throws<EngineConfigException>(() => rootJanitor.Initialize());
    }

    [Fact]
    public void ProbeDirectory_OnlyStaleChildrenAreRemoved()
    {
        using var tmp = new TempDir();
        var (janitor, o) = Make(tmp, new FakeSessions());
        var fresh = System.IO.Path.Combine(o.HardwareProbeDirectory, "fresh");
        var stale = System.IO.Path.Combine(o.HardwareProbeDirectory, "stale");
        WriteFile(System.IO.Path.Combine(fresh, "h264.mkv"), 10);
        WriteFile(System.IO.Path.Combine(stale, "h264.mkv"), 10);
        Directory.SetLastWriteTimeUtc(stale, DateTime.UtcNow.AddHours(-2));
        janitor.Initialize();
        Assert.True(Directory.Exists(fresh));
        Assert.False(Directory.Exists(stale));
    }
}

public class TranscodeEvictionTests
{
    [Fact]
    public void EvictBehindViewer_KeepsNewestAndUnwatchedSegments()
    {
        using var tmp = new TempDir();
        var dir = tmp.Sub("g1");
        Directory.CreateDirectory(dir);
        var playlist = new System.Text.StringBuilder("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n");
        for (var i = 0; i < 30; i++)
        {
            playlist.Append("#EXTINF:4.0,\n").Append($"seg_{i:00000}.m4s\n");
            File.WriteAllBytes(System.IO.Path.Combine(dir, $"seg_{i:00000}.m4s"), new byte[100]);
        }
        File.WriteAllText(System.IO.Path.Combine(dir, "index.m3u8"), playlist.ToString());
        File.WriteAllBytes(System.IO.Path.Combine(dir, "init.mp4"), new byte[10]);
        File.WriteAllBytes(System.IO.Path.Combine(dir, "seg_00030.m4s.tmp"), new byte[100]);

        var probe = BackendLadderTests.Probe("h264", 720);
        var d = new PlaybackDecision { Mode = PlaybackMode.Remux, Video = StreamAction.Copy, Audio = StreamAction.Copy, AudioStreamIndex = 1 };
        var options = new EngineOptions();
        var provider = new HardwareCapabilitiesProvider(null!);
        var job = new TranscodeJob(1, new HlsJobSpec("in.mkv", false, probe, d, null, 0, dir, 4), null,
            new FfmpegBinaries("ffmpeg", "ffprobe"), options, new SystemMonitor(NullLogger<SystemMonitor>.Instance, provider), NullLogger.Instance);
        job.RefreshPlaylist();
        job.ReportViewerPosition(80); // viewer at 80 s: segments ending before 50 s may go

        var freed = job.EvictBehindViewer(long.MaxValue);
        Assert.Equal(12 * 100, freed);   // seg 0..11 end at ≤ 48 s
        Assert.Equal(12, job.EvictedBefore);
        Assert.False(File.Exists(System.IO.Path.Combine(dir, "seg_00011.m4s")));
        Assert.True(File.Exists(System.IO.Path.Combine(dir, "seg_00012.m4s")));
        Assert.True(File.Exists(System.IO.Path.Combine(dir, "init.mp4")));
        Assert.True(File.Exists(System.IO.Path.Combine(dir, "seg_00030.m4s.tmp")));

        job.ReportViewerPosition(10_000); // even when everything is watched, the newest segment stays
        job.EvictBehindViewer(long.MaxValue);
        Assert.True(File.Exists(System.IO.Path.Combine(dir, "seg_00029.m4s")));
        Assert.False(File.Exists(System.IO.Path.Combine(dir, "seg_00028.m4s")));
    }
}

public class CpuSamplingTests
{
    [Fact]
    public void ParsesProcStat()
    {
        var t = SystemMonitor.ParseProcStat("cpu  100 0 50 800 50 0 0 0 0 0");
        Assert.Equal((850UL, 1000UL), t!.Value);
        Assert.Null(SystemMonitor.ParseProcStat("intr 1 2 3"));
    }
}
