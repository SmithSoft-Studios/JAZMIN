using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Jazmin;

/// <summary>
/// Open readers, kept for the next request (issue #275: one encrypted file per tenant, dashboards, published views),
/// least recently used closed first. Thread-safe. <see cref="Open"/> leases a reader: closing or replacing a reader that
/// another request is using would break it, so a reader is replaced or closed only when no lease holds it.
/// <list type="bullet">
/// <item>An idle cached reader is checked with <see cref="JazminReader.Changed"/> on each open; when its file changed it
/// is replaced by <see cref="JazminReader.Refresh"/> and the old one disposed.</item>
/// <item>A reader in use gets a separate reader for that lease only, disposed when the lease is released.</item>
/// <item>Entries are matched by path and an HMAC of the key, access key, password, unlock token, table and priority,
/// under a secret made for this cache: no key or password is a dictionary key.</item>
/// <item>Each open checks whether the cached reader's key has expired; if so the reader is dropped and the file opened
/// again, which fails as <see cref="JazminReader.Open(string, JazminReadOptions?)"/> would.</item>
/// <item>A reader whose lease opened a lock (<see cref="JazminReader.Unlock"/>) is disposed when the lease is released,
/// not kept: a lock stays open as long as its reader, and the next request may not know the password or unlock token.</item>
/// </list>
/// </summary>
public sealed class JazminReaderCache : IDisposable
{
    private sealed class Entry(string id, JazminReader reader)
    {
        public string Id { get; } = id;
        public JazminReader Reader { get; set; } = reader;
        public int Leases;
        public bool Retired;
    }

    private readonly object _gate = new();
    private readonly Dictionary<string, LinkedListNode<Entry>> _entries = new(StringComparer.Ordinal);
    private readonly LinkedList<Entry> _order = new(); // least recently used first
    private readonly byte[] _secret = RandomNumberGenerator.GetBytes(32);
    private bool _disposed;

    /// <param name="max">The most readers kept open (default 100).</param>
    public JazminReaderCache(int max = 100)
    {
        if (max < 1) throw new JazminValidationException("max must be a whole number of readers, at least 1");
        Max = max;
    }

    /// <summary>The most readers kept open.</summary>
    public int Max { get; }

    /// <summary>How many readers are cached (readers of leases opened separately are not counted).</summary>
    public int Count
    {
        get
        {
            lock (_gate) return _entries.Count;
        }
    }

    /// <summary>
    /// Leases a reader of the file at <paramref name="path"/>, opened with <paramref name="options"/> as
    /// <see cref="JazminReader.Open(string, JazminReadOptions?)"/> takes them. Dispose the lease when the request is
    /// done: the reader stays open for the next request.
    /// </summary>
    public JazminReaderLease Open(string path, JazminReadOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(path);
        options ??= new JazminReadOptions();
        var where = Path.GetFullPath(path);
        var id = Id(where, options);
        Entry? entry = null;
        var separate = false;
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_entries.TryGetValue(id, out var node))
            {
                entry = node.Value;
#pragma warning disable CS0618 // the clock option is obsolete for callers, still honoured until 2.0
                var now = options.Now ?? DateTimeOffset.UtcNow;
#pragma warning restore CS0618
                if (entry.Reader.AccessExpires is { } expires && now > expires)
                {
                    Remove(node); // opened again below: refused as Open refuses an expired key
                    entry = null;
                }
                else
                {
                    _order.Remove(node);
                    _order.AddLast(node); // the most recently used
                    if (entry.Leases > 0)
                    {
                        separate = true; // in use: a reader of its own for this lease
                        entry = null;
                    }
                    else
                    {
                        entry.Leases = 1; // this lease: checked and refreshed outside the lock
                    }
                }
            }
        }
        if (separate) return new JazminReaderLease(this, null, JazminReader.OpenFile(where, options, 0));
        if (entry is null) return Add(id, JazminReader.OpenFile(where, options, 0)); // no FileStream buffer: 64 KB less per reader

        JazminReader fresh;
        try
        {
            fresh = entry.Reader.Refresh();
        }
        catch
        {
            lock (_gate)
            {
                if (_entries.TryGetValue(id, out var node) && node.Value == entry) Remove(node);
                entry.Retired = true;
            }
            Release(entry);
            throw;
        }
        if (fresh != entry.Reader)
        {
            JazminReader old;
            lock (_gate) (old, entry.Reader) = (entry.Reader, fresh);
            old.Dispose(); // idle: this lease held it
        }
        return new JazminReaderLease(this, entry, fresh);
    }

    /// <summary>Disposes every cached reader; those leased now are disposed when their leases are released. The cache stays usable.</summary>
    public void Clear()
    {
        lock (_gate)
        {
            while (_order.First is { } node) Remove(node);
        }
    }

    /// <summary><see cref="Clear"/>, and <see cref="Open"/> refuses from now on.</summary>
    public void Dispose()
    {
        lock (_gate)
        {
            _disposed = true;
            while (_order.First is { } node) Remove(node);
        }
    }

    /// <summary>A newly opened reader, cached (the least recently used beyond <see cref="Max"/> leave the cache).</summary>
    private JazminReaderLease Add(string id, JazminReader reader)
    {
        lock (_gate)
        {
            if (_disposed)
            {
                reader.Dispose();
                throw new ObjectDisposedException(nameof(JazminReaderCache));
            }
            // Another request may have cached a reader of this file meanwhile: this one is then this lease's own.
            if (_entries.ContainsKey(id)) return new JazminReaderLease(this, null, reader);
            var entry = new Entry(id, reader) { Leases = 1 };
            _entries[id] = _order.AddLast(entry);
            while (_entries.Count > Max) Remove(_order.First!);
            return new JazminReaderLease(this, entry, reader);
        }
    }

    /// <summary>Out of the cache (under the lock): disposed now, or when its last lease is released.</summary>
    private void Remove(LinkedListNode<Entry> node)
    {
        var entry = node.Value;
        _order.Remove(node);
        _entries.Remove(entry.Id);
        entry.Retired = true;
        if (entry.Leases == 0) entry.Reader.Dispose();
    }

    internal void Release(object? entry, JazminReader reader)
    {
        if (entry is Entry cached) Release(cached);
        else reader.Dispose();
    }

    private void Release(Entry entry)
    {
        lock (_gate)
        {
            if (--entry.Leases > 0) return;
            if (entry.Retired) entry.Reader.Dispose();
            else if (entry.Reader.LocksOpened) Remove(_entries[entry.Id]); // a lock this request opened is not left open for the next one: disposed
            else entry.Reader.Idle(); // waiting for the next request: only what the next query needs again is kept
        }
    }

    /// <summary>The entry's id: the path and an HMAC of what the reader is opened with.</summary>
    private string Id(string where, JazminReadOptions options)
    {
        var what = JsonSerializer.Serialize(new[]
        {
            options.Key?.Export(), options.AccessKey?.Export(), options.Password, options.UnlockToken, options.Table, options.Priority.ToString(),
        });
        return $"{where}\n{Convert.ToBase64String(HMACSHA256.HashData(_secret, Encoding.UTF8.GetBytes(what)))}";
    }
}

/// <summary>A reader leased from a <see cref="JazminReaderCache"/>: dispose it when the request is done.</summary>
public sealed class JazminReaderLease : IDisposable
{
    private readonly JazminReaderCache _cache;
    private readonly object? _entry;
    private int _released;

    internal JazminReaderLease(JazminReaderCache cache, object? entry, JazminReader reader) => (_cache, _entry, Reader) = (cache, entry, reader);

    /// <summary>The reader, for this lease only: don't dispose it, and don't use it after the lease is released.</summary>
    public JazminReader Reader { get; }

    /// <summary>Releases the lease (twice is harmless): the reader stays open for the next request.</summary>
    public void Release()
    {
        if (Interlocked.Exchange(ref _released, 1) == 0) _cache.Release(_entry, Reader);
    }

    /// <summary><see cref="Release"/>, for <c>using</c>.</summary>
    public void Dispose() => Release();
}
