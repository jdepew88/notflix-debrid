namespace Notflix.MediaEngine.Playback;

/// <summary>What the janitor needs to know about live sessions.</summary>
public interface ICacheSessions
{
    /// <summary>True when a directory name directly under the engine scratch root belongs to a live session.</summary>
    bool IsActiveSessionDirectory(string name);

    /// <summary>
    /// Deletes already-watched segments (behind the viewer, idle sessions first, never the newest segment)
    /// until about <paramref name="bytesWanted"/> are freed. Returns the bytes freed.
    /// </summary>
    long EvictBehindViewer(long bytesWanted);
}

public sealed record JanitorSweep(long UsedBytesBefore, long UsedBytesAfter, int DirectoriesRemoved, long SegmentBytesEvicted);

/// <summary>
/// Keeps the engine scratch directory ({cache}/engine) bounded. It only ever deletes inside that root,
/// never follows symlinks/junctions (a link is removed as a link, its target is never touched), and never
/// touches the segment an encoder is currently writing.
/// </summary>
public sealed class CacheJanitor(EngineOptions options, ICacheSessions sessions, ILogger<CacheJanitor> logger)
{
    private static readonly TimeSpan OrphanGrace = TimeSpan.FromMinutes(10);

    public string Root => Path.TrimEndingDirectorySeparator(Path.GetFullPath(options.TempDirectory));
    public long? LastUsedBytes { get; private set; }

    /// <summary>Creates the cache folders, writes the marker file and removes leftovers from a previous run.</summary>
    public int Initialize()
    {
        if (EngineConfig.IsFilesystemRoot(Root)) throw new EngineConfigException($"Refusing to use a filesystem root ({Root}) as the engine cache.");
        Directory.CreateDirectory(options.CacheDirectory);
        Directory.CreateDirectory(Root);
        WriteMarker(options.CacheDirectory);
        if (!EngineConfig.IsSameOrAncestor(options.CacheDirectory, Root)) WriteMarker(Root);

        var removed = 0;
        foreach (var dir in SafeDirectories(Root))
        {
            var name = Path.GetFileName(dir);
            if (name == CacheJanitorNames.ProbeDirectory)
            {
                removed += RemoveStaleChildren(dir, OrphanGrace);
                continue;
            }
            if (sessions.IsActiveSessionDirectory(name)) continue;
            if (DeleteTree(dir)) removed++;
        }
        if (removed > 0) logger.LogInformation("Cache: removed {Count} leftover director(ies) from {Root}", removed, Root);
        return removed;
    }

    /// <summary>Enforces <see cref="EngineOptions.CacheMaxBytes"/> on the engine scratch root.</summary>
    public JanitorSweep Sweep()
    {
        var before = DirectorySize(Root);
        var used = before;
        var removed = 0;

        // Leftovers of sessions that are gone (a failed delete, a crash) are removed once they are stale.
        foreach (var dir in InactiveSessionDirectories())
        {
            if (DateTime.UtcNow - SafeLastWrite(dir) < OrphanGrace) continue;
            var size = DirectorySize(dir);
            if (DeleteTree(dir)) { used -= size; removed++; }
        }

        long evicted = 0;
        if (used > options.CacheMaxBytes)
        {
            // 1. Any directory that no live session owns, oldest first.
            foreach (var dir in InactiveSessionDirectories().OrderBy(SafeLastWrite))
            {
                if (used <= options.CacheMaxBytes) break;
                var size = DirectorySize(dir);
                if (DeleteTree(dir)) { used -= size; removed++; }
            }
            // 2. Already-watched segments of live sessions (idle sessions first).
            if (used > options.CacheMaxBytes)
            {
                evicted = sessions.EvictBehindViewer(used - options.CacheMaxBytes);
                used -= evicted;
            }
            if (used > options.CacheMaxBytes)
                logger.LogWarning("Cache: {Used:0.0} MiB in use exceeds the {Max:0.0} MiB limit; only unwatched output of active sessions remains",
                    used / 1048576.0, options.CacheMaxBytes / 1048576.0);
            else
                logger.LogInformation("Cache: trimmed {Root} from {Before:0.0} MiB to {After:0.0} MiB", Root, before / 1048576.0, used / 1048576.0);
        }
        LastUsedBytes = Math.Max(0, used);
        return new JanitorSweep(before, Math.Max(0, used), removed, evicted);
    }

    private IEnumerable<string> InactiveSessionDirectories() =>
        SafeDirectories(Root).Where(d =>
        {
            var name = Path.GetFileName(d);
            return name != CacheJanitorNames.ProbeDirectory && !sessions.IsActiveSessionDirectory(name);
        }).ToList();

    private int RemoveStaleChildren(string dir, TimeSpan age)
    {
        var removed = 0;
        foreach (var child in SafeDirectories(dir))
            if (DateTime.UtcNow - SafeLastWrite(child) > age && DeleteTree(child)) removed++;
        return removed;
    }

    /// <summary>
    /// Deletes a directory tree strictly inside <see cref="Root"/>. Links (symlinks, junctions) are removed
    /// as links and never descended into. Returns false (and deletes nothing) for any path outside the root.
    /// </summary>
    public bool DeleteTree(string path)
    {
        string full;
        try { full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path)); }
        catch { return false; }
        if (!EngineConfig.IsStrictlyInside(full, Root)) return false;
        try
        {
            var info = new DirectoryInfo(full);
            if (!info.Exists) return !File.Exists(full);
            if (IsLink(info))
            {
                info.Delete();
                return true;
            }
            DeleteContents(info);
            info.Delete();
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogDebug("Cache: could not delete {Path}: {Error}", full, ex.Message);
            return false;
        }
    }

    private static void DeleteContents(DirectoryInfo dir)
    {
        foreach (var entry in dir.EnumerateFileSystemInfos())
        {
            if (entry is DirectoryInfo sub)
            {
                if (IsLink(sub)) sub.Delete();          // removes the link only
                else { DeleteContents(sub); sub.Delete(); }
            }
            else
            {
                if (entry.Attributes.HasFlag(FileAttributes.ReadOnly)) entry.Attributes &= ~FileAttributes.ReadOnly;
                entry.Delete();                         // a file symlink is removed as a link
            }
        }
    }

    private static bool IsLink(FileSystemInfo info) =>
        info.Attributes.HasFlag(FileAttributes.ReparsePoint) || info.LinkTarget is not null;

    /// <summary>Total size of regular files under <paramref name="path"/>, not following links.</summary>
    public static long DirectorySize(string path)
    {
        long total = 0;
        var stack = new Stack<DirectoryInfo>();
        try
        {
            var root = new DirectoryInfo(path);
            if (!root.Exists || IsLink(root)) return 0;
            stack.Push(root);
        }
        catch { return 0; }
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            IEnumerable<FileSystemInfo> entries;
            try { entries = dir.EnumerateFileSystemInfos().ToList(); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { continue; }
            foreach (var e in entries)
            {
                try
                {
                    if (IsLink(e)) continue;
                    if (e is DirectoryInfo d) stack.Push(d);
                    else if (e is FileInfo f) total += f.Length;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* vanished */ }
            }
        }
        return total;
    }

    private static IEnumerable<string> SafeDirectories(string path)
    {
        try
        {
            if (!Directory.Exists(path)) return [];
            return new DirectoryInfo(path).EnumerateDirectories().Select(d => d.FullName).ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return []; }
    }

    private static DateTime SafeLastWrite(string path)
    {
        try { return Directory.GetLastWriteTimeUtc(path); } catch { return DateTime.MinValue; }
    }

    private void WriteMarker(string dir)
    {
        try
        {
            var marker = Path.Combine(dir, CacheJanitorNames.Marker);
            if (!File.Exists(marker))
                File.WriteAllText(marker,
                    "Notflix media cache. Everything in this folder is temporary and may be deleted automatically.\n");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning("Cache: could not write marker in {Dir}: {Error}", dir, ex.Message);
        }
    }
}

/// <summary>Runs the janitor at startup and every 30 seconds.</summary>
public sealed class CacheJanitorService(CacheJanitor janitor, ILogger<CacheJanitorService> logger) : BackgroundService
{
    public override Task StartAsync(CancellationToken cancellationToken)
    {
        janitor.Initialize();
        return base.StartAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken); }
            catch (OperationCanceledException) { break; }
            try { await Task.Run(janitor.Sweep, stoppingToken); }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning("Cache sweep failed: {Error}", ex.Message); }
        }
    }
}
