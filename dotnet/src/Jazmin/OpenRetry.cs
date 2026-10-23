namespace Jazmin;

/// <summary>
/// On Windows, where a one-step replace isn't supported, Update and Compact replace a file that readers have open in
/// two steps (<see cref="WindowsFiles.TryReplaceInTwoSteps"/>): for an instant its path is missing. Opening it is tried
/// again after these waits (about 0.1 s in all) before the "not found" error is given. Mirrors js/src/open-retry.js.
/// </summary>
internal static class OpenRetry
{
    private static readonly int[] MissingWaitsMs = [1, 3, 6, 12, 25, 50];

    /// <summary><see cref="WhenPresent"/>, or null when the path is still missing (Changed: a file that is gone has changed).</summary>
    public static FileStream? WhenPresentOrNull(Func<FileStream> open)
    {
        try
        {
            return WhenPresent(open);
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    /// <summary>Runs <paramref name="open"/>, waiting briefly on Windows for a path that is missing while the file is replaced.</summary>
    public static FileStream WhenPresent(Func<FileStream> open)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                return open();
            }
            catch (FileNotFoundException) when (OperatingSystem.IsWindows() && attempt < MissingWaitsMs.Length)
            {
                Thread.Sleep(MissingWaitsMs[attempt]);
            }
        }
    }
}
