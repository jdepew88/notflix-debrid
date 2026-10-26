using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Notflix.MediaEngine.Processes;

/// <summary>
/// Child-process plumbing.
/// Windows:
///  - every child is assigned to a Job Object with KILL_ON_JOB_CLOSE, so FFmpeg cannot outlive
///    the engine even if the engine crashes or is killed;
///  - suspend/resume (NtSuspendProcess) throttles an encoder that is far ahead of the viewer.
/// Linux/macOS (no Job Objects):
///  - children are tracked and killed when the engine exits normally (SIGTERM/SIGINT/shutdown);
///    callers additionally kill their process on dispose;
///  - suspend/resume use SIGSTOP/SIGCONT.
/// </summary>
public static partial class NativeProcess
{
    private static readonly Lazy<IntPtr> Job = new(CreateKillOnCloseJob);
    private static readonly ConcurrentDictionary<int, Process> Tracked = new();
    private static int _exitHookInstalled;

    public static void AttachToJob(Process process)
    {
        if (OperatingSystem.IsWindows())
        {
            var job = Job.Value;
            if (job == IntPtr.Zero) return;
            try { AssignProcessToJobObject(job, process.Handle); }
            catch { /* best effort: process may have exited already */ }
            return;
        }
        try { Tracked[process.Id] = process; } catch { return; }
        if (Interlocked.Exchange(ref _exitHookInstalled, 1) == 0)
            AppDomain.CurrentDomain.ProcessExit += (_, _) => KillTracked();
    }

    /// <summary>Stops tracking a child that has exited (non-Windows bookkeeping only).</summary>
    public static void Forget(Process process)
    {
        if (OperatingSystem.IsWindows()) return;
        try { Tracked.TryRemove(process.Id, out _); } catch { /* never started */ }
    }

    private static void KillTracked()
    {
        foreach (var p in Tracked.Values)
        {
            try { if (!p.HasExited) p.Kill(entireProcessTree: true); } catch { /* already gone */ }
        }
        Tracked.Clear();
    }

    public static bool Suspend(Process process)
    {
        if (OperatingSystem.IsWindows())
        {
            try { return NtSuspendProcess(process.Handle) == 0; } catch { return false; }
        }
        return Signal(process, OperatingSystem.IsMacOS() ? 17 : 19); // SIGSTOP
    }

    public static bool Resume(Process process)
    {
        if (OperatingSystem.IsWindows())
        {
            try { return NtResumeProcess(process.Handle) == 0; } catch { return false; }
        }
        return Signal(process, OperatingSystem.IsMacOS() ? 19 : 18); // SIGCONT
    }

    private static bool Signal(Process process, int signal)
    {
        if (!(OperatingSystem.IsLinux() || OperatingSystem.IsMacOS())) return false;
        try { return PosixKill(process.Id, signal) == 0; } catch { return false; }
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        if (!OperatingSystem.IsWindows()) return IntPtr.Zero;
        return CreateWindowsJob();
    }

    [SupportedOSPlatform("windows")]
    private static IntPtr CreateWindowsJob()
    {
        var handle = CreateJobObjectW(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) return IntPtr.Zero;

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION { LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE },
        };
        var size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        var ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            SetInformationJobObject(handle, JobObjectExtendedLimitInformation, ptr, (uint)size);
        }
        finally { Marshal.FreeHGlobal(ptr); }
        return handle;
    }

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [LibraryImport("kernel32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr CreateJobObjectW(IntPtr attributes, string? name);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [LibraryImport("ntdll.dll")]
    private static partial int NtSuspendProcess(IntPtr process);

    [LibraryImport("ntdll.dll")]
    private static partial int NtResumeProcess(IntPtr process);

    [LibraryImport("libc", EntryPoint = "kill", SetLastError = true)]
    private static partial int PosixKill(int pid, int signal);
}
