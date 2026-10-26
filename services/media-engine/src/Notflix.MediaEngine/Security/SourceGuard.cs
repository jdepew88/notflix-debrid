using System.Net;
using System.Net.Sockets;

namespace Notflix.MediaEngine.Security;

/// <summary>
/// Defense in depth for media sources. Even with a valid ticket the engine only fetches:
///  - HTTPS URLs on allowlisted public host suffixes that resolve to public addresses, or
///  - explicitly allowlisted private hosts (e.g. a LAN media server), or
///  - local files under configured library roots.
/// This prevents the engine from becoming an open proxy or a private-network scanner.
/// </summary>
public sealed class SourceGuard(EngineOptions options, Func<string, Task<IPAddress[]>>? resolver = null)
{
    private readonly Func<string, Task<IPAddress[]>> _resolve = resolver ?? (host => Dns.GetHostAddressesAsync(host));

    public async Task<Uri> ValidateUrlAsync(string? url)
    {
        if (string.IsNullOrWhiteSpace(url) || !Uri.TryCreate(url, UriKind.Absolute, out var uri))
            throw new SourceRejectedException("invalid source url");
        if (!string.IsNullOrEmpty(uri.UserInfo))
            throw new SourceRejectedException("credentials in url are not allowed");

        var host = uri.IdnHost.ToLowerInvariant();
        var privateAllowed = options.AllowedPrivateHosts.Any(h => string.Equals(h.Trim(), host, StringComparison.OrdinalIgnoreCase));

        if (privateAllowed)
        {
            if (uri.Scheme is not ("http" or "https"))
                throw new SourceRejectedException("unsupported scheme");
            return uri;
        }

        if (uri.Scheme != "https")
            throw new SourceRejectedException("only https sources are allowed");
        if (!IsAllowedSuffix(host))
            throw new SourceRejectedException($"host '{host}' is not allowlisted");
        if (IPAddress.TryParse(host, out _))
            throw new SourceRejectedException("literal ip sources are not allowed");

        IPAddress[] addresses;
        try { addresses = await _resolve(host); }
        catch (SocketException) { throw new SourceRejectedException($"host '{host}' did not resolve"); }
        if (addresses.Length == 0 || addresses.Any(IsPrivate))
            throw new SourceRejectedException($"host '{host}' resolves to a private address");
        return uri;
    }

    public string ValidateFile(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new SourceRejectedException("missing file path");
        string full;
        try { full = Path.GetFullPath(path); }
        catch (Exception) { throw new SourceRejectedException("invalid file path"); }

        foreach (var root in options.LibraryRoots.Where(r => !string.IsNullOrWhiteSpace(r)))
        {
            var rootFull = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)) + Path.DirectorySeparatorChar;
            if (full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
            {
                if (!File.Exists(full)) throw new SourceRejectedException("file not found");
                return full;
            }
        }
        throw new SourceRejectedException("file is outside the configured library roots");
    }

    private bool IsAllowedSuffix(string host) =>
        options.AllowedHostSuffixes.Any(s =>
        {
            var suffix = s.Trim().TrimStart('.').ToLowerInvariant();
            return suffix.Length > 0 && (host == suffix || host.EndsWith("." + suffix, StringComparison.Ordinal));
        });

    public static bool IsPrivate(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip)) return true;
        if (ip.AddressFamily == AddressFamily.InterNetworkV6)
            return ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || ip.IsIPv6UniqueLocal || ip.Equals(IPAddress.IPv6Any);
        var b = ip.GetAddressBytes();
        return b[0] switch
        {
            0 or 10 or 127 => true,
            100 => b[1] >= 64 && b[1] <= 127,      // CGNAT
            169 => b[1] == 254,                     // link-local
            172 => b[1] >= 16 && b[1] <= 31,
            192 => b[1] == 168 || (b[1] == 0 && b[2] == 0),
            198 => b[1] == 18 || b[1] == 19,        // benchmarking
            >= 224 => true,                         // multicast / reserved
            _ => false,
        };
    }
}

public sealed class SourceRejectedException(string message) : Exception(message);
