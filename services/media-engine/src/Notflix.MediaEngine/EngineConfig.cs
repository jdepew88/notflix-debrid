using System.Globalization;
using System.Text.Json;
using Notflix.MediaEngine.Media;

namespace Notflix.MediaEngine;

/// <summary>A configuration problem the engine cannot start with. The message is shown to the owner as-is.</summary>
public sealed class EngineConfigException(string message) : Exception(message);

/// <summary>
/// Resolves engine configuration from the Notflix data directory:
///   {data}/secrets/engine-secret   shared secret (single line, ≥ 32 chars); MEDIA_ENGINE_SECRET overrides
///   {data}/config/engine.json      optional settings (camelCase), written by the web app
/// then environment variables override individual settings. Defaults: port 8421, bind 127.0.0.1,
/// cache {data}/cache, engine scratch {cache}/engine, cache limit 10 GiB.
/// </summary>
public static class EngineConfig
{
    public const string DataDirEnv = "NOTFLIX_DATA_DIR";

    public static string SecretPath(string dataDir) => Path.Combine(dataDir, "secrets", "engine-secret");
    public static string ConfigPath(string dataDir) => Path.Combine(dataDir, "config", "engine.json");

    /// <summary>Reads "--data-dir path" or "--data-dir=path" from the command line.</summary>
    public static string? DataDirFromArgs(IReadOnlyList<string> args)
    {
        for (var i = 0; i < args.Count; i++)
        {
            if (args[i] == "--data-dir" && i + 1 < args.Count) return args[i + 1];
            if (args[i].StartsWith("--data-dir=", StringComparison.Ordinal)) return args[i]["--data-dir=".Length..];
        }
        return null;
    }

    /// <summary>Applies data-dir files and environment variables to <paramref name="options"/>, then validates.</summary>
    public static void Load(EngineOptions options, string? dataDirArg, Func<string, string?> env)
    {
        string? Env(string key) => env(key) is { Length: > 0 } v ? v.Trim() : null;

        var dataDir = !string.IsNullOrWhiteSpace(dataDirArg) ? dataDirArg : Env(DataDirEnv);
        string? cacheFromJson = null;
        if (dataDir is not null)
        {
            dataDir = Path.GetFullPath(dataDir);
            options.DataDirectory = dataDir;
            options.CacheDirectory = Path.Combine(dataDir, "cache");
            var configFile = ConfigPath(dataDir);
            if (File.Exists(configFile)) cacheFromJson = ApplyJson(options, File.ReadAllText(configFile), configFile, dataDir);
        }
        if (cacheFromJson is not null) options.CacheDirectory = cacheFromJson;

        // Environment overrides (development, containers, tests).
        if (Env("MEDIA_ENGINE_PORT") is { } port)
            options.Port = int.TryParse(port, NumberStyles.None, CultureInfo.InvariantCulture, out var p) && p is > 0 and < 65536
                ? p : throw new EngineConfigException($"MEDIA_ENGINE_PORT '{port}' is not a valid port.");
        if (Env("MEDIA_ENGINE_BIND") is { } bind) options.BindAddress = bind;
        if (Env("FFMPEG_PATH") is { } ffmpeg) options.FfmpegPath = ffmpeg;
        if (Env("FFPROBE_PATH") is { } ffprobe) options.FfprobePath = ffprobe;
        if (Env("MEDIA_ENGINE_HWACCEL") is { } hw) options.HardwareAcceleration = ValidHwaccel(hw, "MEDIA_ENGINE_HWACCEL");
        if (Env("MEDIA_ENGINE_MAX_TRANSCODES") is { } max && int.TryParse(max, out var m) && m is >= 1 and <= 16)
            options.MaxConcurrentVideoTranscodes = m;
        if (Env("MEDIA_ENGINE_CACHE_MAX_BYTES") is { } cmb)
            options.CacheMaxBytes = long.TryParse(cmb, NumberStyles.None, CultureInfo.InvariantCulture, out var bytes) && bytes >= EngineOptions.MinCacheMaxBytes
                ? bytes : throw new EngineConfigException($"MEDIA_ENGINE_CACHE_MAX_BYTES must be a whole number of bytes ≥ {EngineOptions.MinCacheMaxBytes} (512 MiB).");
        foreach (var host in Split(Env("MEDIA_ENGINE_ALLOWED_HOSTS"), ','))
            if (!options.AllowedPrivateHosts.Contains(host, StringComparer.OrdinalIgnoreCase)) options.AllowedPrivateHosts.Add(host);
        foreach (var root in Split(Env("MEDIA_ENGINE_LIBRARY_ROOTS"), ';'))
            if (!options.LibraryRoots.Contains(root, StringComparer.OrdinalIgnoreCase)) options.LibraryRoots.Add(root);

        options.CacheDirectory = Path.GetFullPath(options.CacheDirectory);
        options.TempDirectory = Path.GetFullPath(Env("MEDIA_ENGINE_TEMP_DIR") ?? Path.Combine(options.CacheDirectory, "engine"));

        // Secret: environment wins, then the data-dir secret file.
        if (Env("MEDIA_ENGINE_SECRET") is { } envSecret) options.Secret = envSecret;
        else if (string.IsNullOrWhiteSpace(options.Secret) && dataDir is not null && File.Exists(SecretPath(dataDir)))
            options.Secret = File.ReadLines(SecretPath(dataDir)).FirstOrDefault()?.Trim() ?? "";

        if (string.IsNullOrWhiteSpace(options.Secret))
        {
            throw new EngineConfigException(dataDir is null
                ? $"No engine secret. Set {DataDirEnv} (or pass --data-dir <path>) so the engine can read <data>/secrets/engine-secret, or set MEDIA_ENGINE_SECRET."
                : $"No engine secret. Expected a single line of at least 32 characters in {SecretPath(dataDir)} (or set MEDIA_ENGINE_SECRET).");
        }
        if (options.Secret.Length < 32)
        {
            throw new EngineConfigException(Env("MEDIA_ENGINE_SECRET") is not null || dataDir is null
                ? "MEDIA_ENGINE_SECRET is shorter than 32 characters."
                : $"The engine secret in {SecretPath(dataDir)} is shorter than 32 characters.");
        }

        ValidateCacheLocation(options);
    }

    /// <summary>Applies engine.json; returns the configured cache directory (resolved), if any.</summary>
    public static string? ApplyJson(EngineOptions options, string json, string source, string? dataDir)
    {
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(json, new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
        }
        catch (JsonException ex)
        {
            throw new EngineConfigException($"{source} is not valid JSON: {ex.Message}");
        }
        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Object) throw new EngineConfigException($"{source} must contain a JSON object.");
            var props = doc.RootElement.EnumerateObject().ToDictionary(p => p.Name, p => p.Value, StringComparer.OrdinalIgnoreCase);
            JsonElement? Get(string name) => props.TryGetValue(name, out var v) && v.ValueKind != JsonValueKind.Null ? v : null;
            EngineConfigException Bad(string name, string expected) => new($"{source}: \"{name}\" must be {expected}.");
            string? Str(string name) => Get(name) is { } v ? v.ValueKind == JsonValueKind.String ? v.GetString() : throw Bad(name, "a string") : null;
            long? Num(string name) => Get(name) is { } v ? v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : throw Bad(name, "a whole number") : null;
            List<string>? List(string name) => Get(name) is { } v
                ? v.ValueKind == JsonValueKind.Array && v.EnumerateArray().All(x => x.ValueKind == JsonValueKind.String)
                    ? v.EnumerateArray().Select(x => x.GetString()!.Trim()).Where(x => x.Length > 0).ToList()
                    : throw Bad(name, "an array of strings")
                : null;

            if (Num("port") is { } port) options.Port = port is > 0 and < 65536 ? (int)port : throw Bad("port", "between 1 and 65535");
            if (Str("bindAddress") is { Length: > 0 } bind) options.BindAddress = bind;
            if (Num("cacheMaxBytes") is { } cmb)
                options.CacheMaxBytes = cmb >= EngineOptions.MinCacheMaxBytes ? cmb : throw Bad("cacheMaxBytes", $"at least {EngineOptions.MinCacheMaxBytes} (512 MiB)");
            if (Str("hardwareAcceleration") is { Length: > 0 } hw) options.HardwareAcceleration = ValidHwaccel(hw, $"{source}: \"hardwareAcceleration\"");
            if (props.ContainsKey("hardwareDevice"))
                options.HardwareDevice = Str("hardwareDevice") is { Length: > 0 } dev
                    ? ValidDevice(dev) ? dev : throw Bad("hardwareDevice", "a device index or render node path")
                    : null;
            if (Num("maxConcurrentVideoTranscodes") is { } mt)
                options.MaxConcurrentVideoTranscodes = mt is >= 1 and <= 16 ? (int)mt : throw Bad("maxConcurrentVideoTranscodes", "between 1 and 16");
            if (Num("maxTranscodeHeight") is { } mh)
                options.MaxTranscodeHeight = mh is >= 360 and <= 4320 ? (int)mh : throw Bad("maxTranscodeHeight", "between 360 and 4320");
            if (Str("ffmpegPath") is { Length: > 0 } ff) options.FfmpegPath = ff;
            if (Str("ffprobePath") is { Length: > 0 } fp) options.FfprobePath = fp;
            if (List("libraryRoots") is { } roots)
                foreach (var r in roots) if (!options.LibraryRoots.Contains(r, StringComparer.OrdinalIgnoreCase)) options.LibraryRoots.Add(r);
            if (List("allowedPrivateHosts") is { } hosts)
                foreach (var h in hosts) if (!options.AllowedPrivateHosts.Contains(h, StringComparer.OrdinalIgnoreCase)) options.AllowedPrivateHosts.Add(h);
            if (Str("cacheDirectory") is { Length: > 0 } cache)
                return Path.IsPathRooted(cache) || dataDir is null ? Path.GetFullPath(cache) : Path.GetFullPath(Path.Combine(dataDir, cache));
            return null;
        }
    }

    public static string ValidHwaccel(string value, string what)
    {
        var v = value.Trim().ToLowerInvariant();
        return HwBackends.RequestValues.Contains(v) ? v
            : throw new EngineConfigException($"{what} must be one of {string.Join(", ", HwBackends.RequestValues)} (got '{value}').");
    }

    /// <summary>A GPU/adapter index ("0") or a Linux render node ("/dev/dri/renderD128").</summary>
    public static bool ValidDevice(string? device) =>
        device is not null && (System.Text.RegularExpressions.Regex.IsMatch(device, @"^\d{1,2}$") ||
                               System.Text.RegularExpressions.Regex.IsMatch(device, @"^/dev/dri/(renderD|card)\d{1,4}$"));

    /// <summary>
    /// The cache is deleted from automatically, so it must never be a filesystem root or contain the
    /// data directory's secrets/, db/ or config/ folders.
    /// </summary>
    public static void ValidateCacheLocation(EngineOptions options)
    {
        foreach (var (what, dir) in new[] { ("cacheDirectory", options.CacheDirectory), ("engine scratch directory", options.TempDirectory) })
        {
            var full = Path.GetFullPath(dir);
            if (IsFilesystemRoot(full))
                throw new EngineConfigException($"The {what} ({full}) is a filesystem root. Choose a dedicated folder such as <data>/cache.");
            if (options.DataDirectory is { } data)
            {
                foreach (var protectedDir in new[] { "secrets", "db", "config" }.Select(d => Path.Combine(data, d)))
                    if (IsSameOrAncestor(full, protectedDir))
                        throw new EngineConfigException($"The {what} ({full}) would contain {protectedDir}. Choose a dedicated folder such as {Path.Combine(data, "cache")}.");
            }
        }
    }

    public static bool IsFilesystemRoot(string fullPath)
    {
        var trimmed = Path.TrimEndingDirectorySeparator(fullPath);
        var root = Path.GetPathRoot(fullPath);
        return string.IsNullOrEmpty(root) || string.Equals(Path.TrimEndingDirectorySeparator(root), trimmed, PathComparison) ||
               trimmed.Length == 0;
    }

    /// <summary>True when <paramref name="candidate"/> equals <paramref name="path"/> or is one of its parent directories.</summary>
    public static bool IsSameOrAncestor(string candidate, string path)
    {
        var a = Path.TrimEndingDirectorySeparator(Path.GetFullPath(candidate));
        var b = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        if (string.Equals(a, b, PathComparison)) return true;
        return b.StartsWith(a + Path.DirectorySeparatorChar, PathComparison) ||
               (Path.AltDirectorySeparatorChar != Path.DirectorySeparatorChar && b.StartsWith(a + Path.AltDirectorySeparatorChar, PathComparison));
    }

    /// <summary>True when <paramref name="path"/> is strictly inside <paramref name="root"/>.</summary>
    public static bool IsStrictlyInside(string path, string root) =>
        !string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(path)), Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)), PathComparison) &&
        IsSameOrAncestor(root, path);

    public static StringComparison PathComparison =>
        OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    private static IEnumerable<string> Split(string? value, char separator) =>
        (value ?? "").Split(separator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}
