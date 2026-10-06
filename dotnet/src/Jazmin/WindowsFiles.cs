using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Jazmin;

/// <summary>
/// Windows refuses to replace a file that is open (TASKS W-1). Readers open files so that they may be renamed, so a file
/// can still be replaced while they read it: they keep reading the version they opened, as on Linux and macOS.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class WindowsFiles
{
    private const uint Delete = 0x00010000, Synchronize = 0x00100000, ShareAll = 0x7, OpenExisting = 3;
    private const int FileRenameInfoEx = 22;
    private const uint ReplaceIfExists = 0x1, PosixSemantics = 0x2;

    /// <summary>
    /// Replaces <paramref name="destination"/> with <paramref name="source"/> in one step with POSIX semantics (Windows
    /// 10 version 1709 and later, on NTFS): the old file leaves the folder at once, and readers that have it open keep
    /// it. False where the system or the file system doesn't support it.
    /// </summary>
    public static bool TryPosixReplace(string source, string destination)
    {
        var name = Encoding.Unicode.GetBytes(Path.GetFullPath(destination));
        // FILE_RENAME_INFO: Flags (4 bytes), RootDirectory (a handle, pointer-aligned), FileNameLength (4 bytes), FileName.
        var lengthAt = 2 * IntPtr.Size;
        var nameAt = lengthAt + 4;
        var info = new byte[nameAt + name.Length + sizeof(char)];
        BinaryPrimitives.WriteUInt32LittleEndian(info, ReplaceIfExists | PosixSemantics);
        BinaryPrimitives.WriteUInt32LittleEndian(info.AsSpan(lengthAt), (uint)name.Length);
        name.CopyTo(info, nameAt);

        using var handle = CreateFileW(Path.GetFullPath(source), Delete | Synchronize, ShareAll, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
        if (handle.IsInvalid) return false;
        var pinned = GCHandle.Alloc(info, GCHandleType.Pinned);
        try
        {
            return SetFileInformationByHandle(handle, FileRenameInfoEx, pinned.AddrOfPinnedObject(), (uint)info.Length);
        }
        finally
        {
            pinned.Free();
        }
    }

    /// <summary>
    /// Replaces in two steps where one isn't available: the open file is moved aside, the new version takes its place,
    /// and the old one is deleted. For an instant the path is missing; if the new version can't take its place, the old
    /// one is put back. False, with nothing changed, when the open file can't be moved: a program holds it without
    /// allowing that.
    /// </summary>
    public static bool TryReplaceInTwoSteps(string source, string destination)
    {
        var aside = $"{destination}.{Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant()}.old";
        try
        {
            File.Move(destination, aside);
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException)
        {
            return false;
        }
        try
        {
            File.Move(source, destination);
        }
        catch
        {
            File.Move(aside, destination);
            throw;
        }
        try
        {
            File.Delete(aside);
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException)
        {
            // Not deleted now: the new version is in place, and the old one is only a leftover.
        }
        return true;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, IntPtr info, uint size);
}
