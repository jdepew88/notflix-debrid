using System.Diagnostics;
using System.Net;
using Microsoft.Net.Http.Headers;
using Notflix.MediaEngine.Media;
using Notflix.MediaEngine.Playback;

namespace Notflix.MediaEngine.Api;

/// <summary>
/// Direct Play: relays the original bytes with HTTP range support. Never buffers the whole file —
/// bytes are copied straight from the upstream response to the client with a small buffer, and the
/// upstream request is cancelled the moment the browser disconnects.
/// </summary>
public sealed class DirectStreamer(IHttpClientFactory httpFactory, ILogger<DirectStreamer> logger)
{
    public const string ClientName = "direct";

    private static readonly string[] PassHeaders =
        [HeaderNames.ContentType, HeaderNames.ContentLength, HeaderNames.ContentRange, HeaderNames.LastModified, HeaderNames.ETag];

    public async Task StreamAsync(HttpContext ctx, PlaybackSession session)
    {
        var ct = ctx.RequestAborted;
        if (!session.IsRemote)
        {
            await StreamFileAsync(ctx, session);
            return;
        }

        var request = new HttpRequestMessage(HttpMethod.Get, session.Input);
        request.Headers.TryAddWithoutValidation("User-Agent", MediaProber.UserAgent);
        if (ctx.Request.Headers.Range is { Count: > 0 } range)
            request.Headers.TryAddWithoutValidation("Range", range.ToString());
        if (ctx.Request.Headers.IfRange is { Count: > 0 } ifRange)
            request.Headers.TryAddWithoutValidation("If-Range", ifRange.ToString());

        var sw = Stopwatch.StartNew();
        long copied = 0;
        session.DirectStreamStarted();
        try
        {
            using var response = await httpFactory.CreateClient(ClientName)
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Forbidden or HttpStatusCode.Gone)
            {
                session.AddEvent("error", $"Source returned {(int)response.StatusCode} (link expired?)");
                ctx.Response.StatusCode = StatusCodes.Status410Gone;
                await ctx.Response.WriteAsJsonAsync(new { error = "The source link expired.", code = "source-expired" }, ct);
                return;
            }

            ctx.Response.StatusCode = (int)response.StatusCode;
            foreach (var name in PassHeaders)
            {
                if (response.Headers.TryGetValues(name, out var v) || response.Content.Headers.TryGetValues(name, out v))
                    ctx.Response.Headers[name] = v.ToArray();
            }
            ctx.Response.Headers.AcceptRanges = "bytes";
            ctx.Response.Headers.CacheControl = "no-store";
            if (string.IsNullOrEmpty(ctx.Response.ContentType)) ctx.Response.ContentType = GuessType(session);
            // Some CDNs label media as octet-stream; browsers sniff poorly for range responses.
            if (ctx.Response.ContentType == "application/octet-stream") ctx.Response.ContentType = GuessType(session);

            await using var upstream = await response.Content.ReadAsStreamAsync(ct);
            var buffer = new byte[128 * 1024];
            int read;
            while ((read = await upstream.ReadAsync(buffer, ct)) > 0)
            {
                await ctx.Response.Body.WriteAsync(buffer.AsMemory(0, read), ct);
                copied += read;
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Browser seeked or closed the tab; normal for range playback.
        }
        catch (HttpRequestException ex)
        {
            logger.LogWarning("Direct stream upstream error for session {Id}: {Error}", session.Id, ex.Message);
            session.AddEvent("error", "Source connection failed during direct play");
            if (!ctx.Response.HasStarted)
            {
                ctx.Response.StatusCode = StatusCodes.Status502BadGateway;
                await ctx.Response.WriteAsJsonAsync(new { error = "The source could not be reached.", code = "source-unreachable" });
            }
        }
        finally
        {
            session.DirectStreamFinished(copied, sw.ElapsedMilliseconds);
        }
    }

    private static async Task StreamFileAsync(HttpContext ctx, PlaybackSession session)
    {
        var sw = Stopwatch.StartNew();
        session.DirectStreamStarted();
        long length = 0;
        try
        {
            length = new FileInfo(session.Input).Length;
            await Results.File(session.Input, GuessType(session), enableRangeProcessing: true).ExecuteAsync(ctx);
        }
        catch (OperationCanceledException) { }
        finally
        {
            // Range length is not exposed by Results.File; report the request count via bytes=0 for files.
            session.DirectStreamFinished(ctx.Response.ContentLength ?? Math.Min(length, 0), sw.ElapsedMilliseconds);
        }
    }

    private static string GuessType(PlaybackSession session) => session.Probe.Container switch
    {
        "webm" => "video/webm",
        _ => "video/mp4",
    };
}
