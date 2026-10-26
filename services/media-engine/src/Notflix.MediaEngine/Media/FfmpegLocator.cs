namespace Notflix.MediaEngine.Media;

public sealed record FfmpegBinaries(string Ffmpeg, string Ffprobe)
{
    /// <summary>The ffmpeg executable exists at <see cref="Ffmpeg"/> (or was found on PATH).</summary>
    public bool FfmpegFound { get; init; } = true;
    public bool FfprobeFound { get; init; } = true;
    public bool Found => FfmpegFound && FfprobeFound;
}

/// <summary>
/// Finds ffmpeg/ffprobe: explicit config, then well-known install folders (WinGet/Gyan, Program Files,
/// /usr/bin, /usr/local/bin, Homebrew), then PATH. Never throws: a missing binary is reported as not found.
/// </summary>
public static class FfmpegLocator
{
    public static FfmpegBinaries Locate(EngineOptions options) =>
        Locate(options.FfmpegPath, options.FfprobePath, HostOsNow(), Environment.GetEnvironmentVariable, File.Exists, Directory.Exists, Directory.EnumerateDirectories);

    public static FfmpegBinaries Locate(
        string? ffmpegPath,
        string? ffprobePath,
        HostOs os,
        Func<string, string?> env,
        Func<string, bool> fileExists,
        Func<string, bool> dirExists,
        Func<string, string, IEnumerable<string>> enumerateDirs)
    {
        string Exe(string name) => os == HostOs.Windows ? name + ".exe" : name;

        if (!string.IsNullOrWhiteSpace(ffmpegPath))
        {
            var probe = ffprobePath;
            if (string.IsNullOrWhiteSpace(probe))
                probe = Path.Combine(Path.GetDirectoryName(ffmpegPath) ?? "", Exe("ffprobe"));
            return new FfmpegBinaries(ffmpegPath, probe) { FfmpegFound = fileExists(ffmpegPath), FfprobeFound = fileExists(probe) };
        }

        foreach (var dir in CandidateDirectories(os, env, dirExists, enumerateDirs))
        {
            var ffmpeg = Path.Combine(dir, Exe("ffmpeg"));
            var ffprobe = Path.Combine(dir, Exe("ffprobe"));
            if (fileExists(ffmpeg) && fileExists(ffprobe))
            {
                if (!string.IsNullOrWhiteSpace(ffprobePath)) ffprobe = ffprobePath;
                return new FfmpegBinaries(ffmpeg, ffprobe) { FfprobeFound = fileExists(ffprobe) };
            }
        }

        return new FfmpegBinaries(Exe("ffmpeg"), string.IsNullOrWhiteSpace(ffprobePath) ? Exe("ffprobe") : ffprobePath)
        {
            FfmpegFound = false,
            FfprobeFound = !string.IsNullOrWhiteSpace(ffprobePath) && fileExists(ffprobePath),
        };
    }

    private static IEnumerable<string> CandidateDirectories(
        HostOs os, Func<string, string?> env, Func<string, bool> dirExists, Func<string, string, IEnumerable<string>> enumerateDirs)
    {
        if (os == HostOs.Windows)
        {
            var local = env("LOCALAPPDATA");
            if (!string.IsNullOrEmpty(local))
            {
                yield return Path.Combine(local, "Microsoft", "WinGet", "Links");
                var packages = Path.Combine(local, "Microsoft", "WinGet", "Packages");
                if (dirExists(packages))
                {
                    foreach (var pkg in SafeEnumerate(enumerateDirs, packages, "Gyan.FFmpeg*"))
                    foreach (var build in SafeEnumerate(enumerateDirs, pkg, "*"))
                        yield return Path.Combine(build, "bin");
                }
            }
            var programFiles = env("ProgramFiles") ?? @"C:\Program Files";
            yield return Path.Combine(programFiles, "ffmpeg", "bin");
            yield return @"C:\ffmpeg\bin";
        }
        else
        {
            if (os == HostOs.MacOS) yield return "/opt/homebrew/bin";
            yield return "/usr/local/bin";
            yield return "/usr/bin";
            if (os == HostOs.Linux) yield return "/usr/lib/jellyfin-ffmpeg";
        }
        foreach (var p in (env("PATH") ?? "").Split(Path.PathSeparator))
            if (!string.IsNullOrWhiteSpace(p)) yield return p.Trim();
    }

    private static IEnumerable<string> SafeEnumerate(Func<string, string, IEnumerable<string>> enumerate, string path, string pattern)
    {
        try { return enumerate(path, pattern).ToList(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return []; }
    }

    private static HostOs HostOsNow() =>
        OperatingSystem.IsWindows() ? HostOs.Windows : OperatingSystem.IsLinux() ? HostOs.Linux : OperatingSystem.IsMacOS() ? HostOs.MacOS : HostOs.Other;
}
