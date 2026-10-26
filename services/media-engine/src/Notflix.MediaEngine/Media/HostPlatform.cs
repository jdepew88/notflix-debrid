using System.Runtime.InteropServices;

namespace Notflix.MediaEngine.Media;

public enum HostOs { Windows, Linux, MacOS, Other }

/// <summary>
/// The operating system facts and file reads hardware detection depends on. Abstracted so detection
/// can be tested for Linux/macOS/Windows machines from any machine.
/// </summary>
public interface IHostPlatform
{
    HostOs Os { get; }
    string Arch { get; }
    string OsDescription { get; }
    bool FileExists(string path);
    string? ReadText(string path);
    IEnumerable<string> EnumerateDirectories(string path, string pattern);
}

public sealed class SystemHostPlatform : IHostPlatform
{
    public HostOs Os { get; } =
        OperatingSystem.IsWindows() ? HostOs.Windows
        : OperatingSystem.IsLinux() ? HostOs.Linux
        : OperatingSystem.IsMacOS() ? HostOs.MacOS
        : HostOs.Other;

    public string Arch => RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant();
    public string OsDescription => RuntimeInformation.OSDescription;
    public bool FileExists(string path) => File.Exists(path);

    public string? ReadText(string path)
    {
        try { return File.Exists(path) ? File.ReadAllText(path) : null; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    public IEnumerable<string> EnumerateDirectories(string path, string pattern)
    {
        try { return Directory.Exists(path) ? Directory.EnumerateDirectories(path, pattern).ToList() : []; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return []; }
    }

    public static string OsName(HostOs os) => os switch
    {
        HostOs.Windows => "windows",
        HostOs.Linux => "linux",
        HostOs.MacOS => "macos",
        _ => "other",
    };
}
