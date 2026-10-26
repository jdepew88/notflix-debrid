using System.Diagnostics;
using System.Text;

namespace Notflix.MediaEngine.Processes;

public sealed record ProcessResult(int ExitCode, string StdOut, string StdErr, bool TimedOut)
{
    /// <summary>The executable could not be started at all (not installed / not on PATH).</summary>
    public bool StartFailed => ExitCode == -1 && !TimedOut;
}

/// <summary>
/// Runs short-lived tools (ffmpeg capability checks, nvidia-smi, adapter enumeration). An interface so
/// hardware detection can be exercised in tests with canned output for machines we do not have.
/// </summary>
public interface IProcessRunner
{
    Task<ProcessResult> RunAsync(string fileName, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct = default);
}

public sealed class SystemProcessRunner : IProcessRunner
{
    public Task<ProcessResult> RunAsync(string fileName, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct = default) =>
        ProcessRunner.RunAsync(fileName, args, timeout, ct);
}

/// <summary>Runs short-lived tools (ffprobe, capability checks, nvidia-smi) with a hard timeout.</summary>
public static class ProcessRunner
{
    public static async Task<ProcessResult> RunAsync(
        string fileName,
        IEnumerable<string> args,
        TimeSpan timeout,
        CancellationToken ct = default)
    {
        var psi = new ProcessStartInfo(fileName)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = false,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var process = new Process { StartInfo = psi };
        try
        {
            if (!process.Start()) return new ProcessResult(-1, "", "failed to start", false);
        }
        catch (Exception ex)
        {
            return new ProcessResult(-1, "", ex.Message, false);
        }
        NativeProcess.AttachToJob(process);

        var stdout = process.StandardOutput.ReadToEndAsync(ct);
        var stderr = process.StandardError.ReadToEndAsync(ct);

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);
        var timedOut = false;
        try
        {
            await process.WaitForExitAsync(timeoutCts.Token);
        }
        catch (OperationCanceledException)
        {
            timedOut = !ct.IsCancellationRequested;
            try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
            if (!timedOut) throw;
        }

        string Out(Task<string> t) => t.IsCompletedSuccessfully ? t.Result : "";
        try { await Task.WhenAll(stdout, stderr).WaitAsync(TimeSpan.FromSeconds(2), CancellationToken.None); }
        catch { /* streams may not drain after a kill */ }
        NativeProcess.Forget(process);
        return new ProcessResult(timedOut ? -1 : process.ExitCode, Out(stdout), Out(stderr), timedOut);
    }
}
