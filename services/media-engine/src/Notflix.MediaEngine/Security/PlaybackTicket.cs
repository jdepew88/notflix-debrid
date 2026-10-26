using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Notflix.MediaEngine.Security;

/// <summary>Source description carried inside a signed ticket. Only Next.js can mint these.</summary>
public sealed class TicketSource
{
    /// <summary>"url" (HTTPS/HTTP upstream) or "file" (local path under a library root).</summary>
    [JsonPropertyName("kind")] public string Kind { get; set; } = "url";
    [JsonPropertyName("url")] public string? Url { get; set; }
    [JsonPropertyName("path")] public string? Path { get; set; }
    /// <summary>"real-debrid", "plex", "library", "sample".</summary>
    [JsonPropertyName("provider")] public string Provider { get; set; } = "real-debrid";
    [JsonPropertyName("fileName")] public string? FileName { get; set; }
    [JsonPropertyName("fileSize")] public long? FileSize { get; set; }
    [JsonPropertyName("title")] public string? Title { get; set; }
}

public sealed class TicketPayload
{
    [JsonPropertyName("v")] public int Version { get; set; } = 1;
    [JsonPropertyName("owner")] public string Owner { get; set; } = "";
    [JsonPropertyName("exp")] public long ExpiresAtUnix { get; set; }
    [JsonPropertyName("nonce")] public string Nonce { get; set; } = "";
    [JsonPropertyName("src")] public TicketSource Source { get; set; } = new();
}

/// <summary>
/// Ticket format: base64url(json) + "." + base64url(HMAC-SHA256(secret, base64url(json))).
/// Tickets are single-use and expire quickly (Next.js mints them with a 60 s lifetime).
/// </summary>
public sealed class TicketValidator(byte[] key, TimeProvider? time = null)
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, long> _usedNonces = new();
    private static readonly TimeSpan MaxClockSkewLifetime = TimeSpan.FromMinutes(5);

    public static string Sign(TicketPayload payload, byte[] key)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(payload);
        var body = Base64Url(json);
        var sig = Base64Url(HMACSHA256.HashData(key, Encoding.ASCII.GetBytes(body)));
        return $"{body}.{sig}";
    }

    public TicketPayload Validate(string ticket)
    {
        if (string.IsNullOrWhiteSpace(ticket)) throw new TicketException("missing ticket");
        var dot = ticket.IndexOf('.');
        if (dot <= 0 || dot != ticket.LastIndexOf('.')) throw new TicketException("malformed ticket");

        var body = ticket[..dot];
        var sig = ticket[(dot + 1)..];
        var expected = HMACSHA256.HashData(key, Encoding.ASCII.GetBytes(body));
        byte[] provided;
        try { provided = FromBase64Url(sig); }
        catch (FormatException) { throw new TicketException("malformed signature"); }
        if (!CryptographicOperations.FixedTimeEquals(expected, provided))
            throw new TicketException("bad signature");

        TicketPayload payload;
        try
        {
            payload = JsonSerializer.Deserialize<TicketPayload>(FromBase64Url(body))
                      ?? throw new TicketException("empty ticket");
        }
        catch (Exception ex) when (ex is JsonException or FormatException)
        {
            throw new TicketException("unreadable ticket");
        }

        var now = _time.GetUtcNow();
        var exp = DateTimeOffset.FromUnixTimeSeconds(payload.ExpiresAtUnix);
        if (exp < now) throw new TicketException("ticket expired");
        if (exp - now > MaxClockSkewLifetime) throw new TicketException("ticket lifetime too long");
        if (payload.Nonce.Length < 16) throw new TicketException("weak nonce");
        if (string.IsNullOrEmpty(payload.Owner)) throw new TicketException("missing owner");

        PruneNonces(now.ToUnixTimeSeconds());
        if (!_usedNonces.TryAdd(payload.Nonce, payload.ExpiresAtUnix))
            throw new TicketException("ticket already used");

        return payload;
    }

    private void PruneNonces(long nowUnix)
    {
        if (_usedNonces.Count < 256) return;
        foreach (var (nonce, exp) in _usedNonces)
            if (exp < nowUnix) _usedNonces.TryRemove(nonce, out _);
    }

    public static string Base64Url(ReadOnlySpan<byte> data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] FromBase64Url(string s)
    {
        var padded = s.Replace('-', '+').Replace('_', '/');
        padded += (padded.Length % 4) switch { 2 => "==", 3 => "=", 0 => "", _ => throw new FormatException() };
        return Convert.FromBase64String(padded);
    }
}

public sealed class TicketException(string message) : Exception(message);
