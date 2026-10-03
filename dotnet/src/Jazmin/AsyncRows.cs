using System.Runtime.CompilerServices;

namespace Jazmin;

/// <summary>Turns a synchronous query into an async stream without blocking the caller's thread.</summary>
internal static class AsyncRows
{
    private const int BatchSize = 512;

    /// <summary>
    /// Each batch of items is produced on a thread-pool thread (file reads and decoding happen there) while the caller
    /// awaits. Nothing runs between batches, so the caller may use the same reader between items, and at most one batch
    /// is held at a time.
    /// </summary>
    public static async IAsyncEnumerable<T> Of<T>(IEnumerable<T> source, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        using var items = source.GetEnumerator();
        var batch = new List<T>(BatchSize);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            batch.Clear();
            await Task.Run(() =>
            {
                while (batch.Count < BatchSize && !cancellationToken.IsCancellationRequested && items.MoveNext()) batch.Add(items.Current);
            }, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (batch.Count == 0) yield break;
            foreach (var item in batch) yield return item;
            if (batch.Count < BatchSize) yield break;
        }
    }
}
