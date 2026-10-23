using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// On Windows, where a one-step replace isn't supported, Update and Compact replace a file that readers have open in
/// two steps: for an instant its path is missing. A reader opening it then waits briefly for the new version
/// (issue #275). Mirrors js/test/open-retry.test.js.
/// </summary>
public sealed class OpenRetryTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-retry-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private string Sample()
    {
        var path = Path.Combine(_dir, "r.jzm");
        using var writer = JazminWriter.Create(path, [new JazminColumn("id", JazminType.Int)]);
        writer.WriteRow(new Dictionary<string, object?> { ["id"] = 1L });
        writer.WriteRow(new Dictionary<string, object?> { ["id"] = 2L });
        return path;
    }

    /// <summary>
    /// Moves the file away; once <c>opening</c> is set, puts it back after a few milliseconds, on a thread of its own (a
    /// busy thread pool could start a task too late).
    /// </summary>
    private static Task MoveAwayAndBack(string path, ManualResetEventSlim opening)
    {
        File.Move(path, path + ".away");
        var done = new TaskCompletionSource();
        var thread = new Thread(() =>
        {
            try
            {
                opening.Wait();
                Thread.Sleep(5);
                File.Move(path + ".away", path);
                done.SetResult();
            }
            catch (Exception error)
            {
                done.SetException(error);
            }
        }) { IsBackground = true, Priority = ThreadPriority.Highest };
        thread.Start();
        return done.Task;
    }

    [Fact]
    public async Task Open_WaitsBrieflyForAFileWhosePathIsMissingWhileItIsReplaced()
    {
        if (!OperatingSystem.IsWindows()) return; // the path is briefly missing only on Windows
        var path = Sample();
        using var opening = new ManualResetEventSlim();
        var back = MoveAwayAndBack(path, opening);
        Assert.False(File.Exists(path));
        opening.Set();
        JazminReader r;
        try
        {
            r = JazminReader.Open(path);
        }
        finally
        {
            await back;
        }
        using (r) Assert.Equal(2, r.RowCount);
    }

    [Fact]
    public async Task Inspect_WaitsBrieflyToo()
    {
        if (!OperatingSystem.IsWindows()) return; // the path is briefly missing only on Windows
        var path = Sample();
        using var opening = new ManualResetEventSlim();
        var back = MoveAwayAndBack(path, opening);
        Assert.False(File.Exists(path));
        opening.Set();
        JazminFileInfo info;
        try
        {
            info = JazminFile.Inspect(path);
        }
        finally
        {
            await back;
        }
        Assert.Equal("1.0", info.Version);
    }

    [Fact]
    public async Task OpenAsync_WaitsBrieflyForAFileWhosePathIsMissingWhileItIsReplaced()
    {
        if (!OperatingSystem.IsWindows()) return; // the path is briefly missing only on Windows
        var path = Sample();
        using var opening = new ManualResetEventSlim();
        var back = MoveAwayAndBack(path, opening);
        opening.Set();
        JazminReader r;
        try
        {
            r = await JazminReader.OpenAsync(path);
        }
        finally
        {
            await back;
        }
        using (r) Assert.Equal(2, r.RowCount);
    }

    [Fact]
    public void AFileThatStaysMissing_StillFailsToOpen_WithTheSystemError()
    {
        if (!OperatingSystem.IsWindows()) return; // the path is briefly missing only on Windows
        Assert.Throws<FileNotFoundException>(() => JazminReader.Open(Path.Combine(_dir, "none.jzm")));
    }
}
