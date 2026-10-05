using Jazmin.Format;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// The sorted index builder (TASKS P-5) must write exactly the pages it always has: the same keys in the same order,
/// with the same postings, whatever order rows arrive in. Compared with the 1.0 builder, kept here as the reference.
/// </summary>
public sealed class IndexBuilderTests
{
    /// <summary>The 1.0 builder: a list per key, sorted with the key comparer.</summary>
    private sealed class ReferenceBuilder(JazminType type)
    {
        private readonly Dictionary<object, List<long>> _entries = new();

        public void Add(long rowId, object? value)
        {
            if (value is null) return;
            var key = Values.ToKey(type, value);
            if (Values.IsNaN(key)) return;
            if (!_entries.TryGetValue(key, out var ids)) _entries[key] = ids = new List<long>();
            ids.Add(rowId);
        }

        public List<(byte[] First, int Count, byte[] Raw)> Pages(int pageBytes)
        {
            var keys = _entries.Keys.ToArray();
            Array.Sort(keys, KeyComparer.Instance);
            var pages = new List<(byte[], int, byte[])>();
            var body = new ByteWriter(1024);
            object? first = null;
            var count = 0;
            void Flush()
            {
                var raw = new ByteWriter(body.Length + 11);
                raw.Byte(FormatConstants.PostingsEncoding);
                raw.VarUInt((ulong)count);
                raw.Bytes(body.AsSpan());
                pages.Add((Bounds.Encode(type, first!), count, raw.ToArray()));
                body.Reset();
                count = 0;
            }
            foreach (var key in keys)
            {
                if (count == 0) first = key;
                Values.Encode(body, type, key);
                RowSet.WritePostings(body, _entries[key]);
                count++;
                if (body.Length >= pageBytes) Flush();
            }
            if (count > 0) Flush();
            return pages;
        }
    }

    public static TheoryData<string> Cases() => ["int", "int sorted", "int repeated", "float", "string", "string sorted", "datetime", "bool", "decimal",
        "string, appended rows", "string, regrouped", "int, keys repeated across runs", "int, 31 runs", "int, 32 runs", "int, 33 runs", "int, 40 runs",
        "decimal forms, almost in order", "decimal forms in runs"];

    private static (JazminType Type, List<object?> Values) Data(string name)
    {
        var random = new Random(name.GetHashCode(StringComparison.Ordinal) & 0x7fff);
        const int n = 20_000;
        return name switch
        {
            "int" => (JazminType.Int, Enumerable.Range(0, n).Select(_ => (object?)(long)random.Next(-50_000, 50_000)).ToList()),
            "int sorted" => (JazminType.Int, Enumerable.Range(0, n).Select(i => (object?)(long)i).ToList()),
            "int repeated" => (JazminType.Int, Enumerable.Range(0, n).Select(i => i % 9 == 0 ? null : (object?)(long)(i % 7)).ToList()),
            "float" => (JazminType.Float, Enumerable.Range(0, n).Select(i => (object?)(i % 50 == 0 ? double.NaN : i % 51 == 0 ? -0.0 : i % 52 == 0 ? 0.0 : Math.Round(random.NextDouble() * 1000 - 500, 2))).ToList()),
            "string" => (JazminType.String, Enumerable.Range(0, n).Select(_ => (object?)new string(Enumerable.Range(0, random.Next(0, 6)).Select(_ => "aBzé中😀"[random.Next(7)]).ToArray())).ToList()),
            "string sorted" => (JazminType.String, Enumerable.Range(0, n).Select(i => (object?)$"ACC-{i:D6}").ToList()),
            "datetime" => (JazminType.DateTime, Enumerable.Range(0, n).Select(_ => (object?)new DateTime(2025, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMinutes(random.Next(0, 500_000))).ToList()),
            "bool" => (JazminType.Bool, Enumerable.Range(0, n).Select(i => i % 5 == 0 ? null : (object?)(random.Next(2) == 0)).ToList()),
            "decimal" => (JazminType.Decimal, Enumerable.Range(0, n).Select(_ => (object?)(random.Next(0, 2000) / 100m).ToString(random.Next(2) == 0 ? "F2" : "F3", System.Globalization.CultureInfo.InvariantCulture)).ToList()),
            // Almost in order (sorted runs, merged when the pages are written): rows appended after the rest, partitions
            // regrouped, the same keys in several runs, and the run count around the limit where the builder uses a table.
            "string, appended rows" => (JazminType.String, Enumerable.Range(0, n).Select(i => (object?)$"r{i:D6}").Concat(["r000005", "r000010", "a", "zz"]).ToList()),
            "string, regrouped" => (JazminType.String, Enumerable.Range(0, 30).SelectMany(b => Enumerable.Range(0, 500).Select(i => (object?)$"r{(b * 7 % 30) * 500 + i:D6}")).ToList()),
            "int, keys repeated across runs" => (JazminType.Int, Enumerable.Range(0, 20).SelectMany(_ => Enumerable.Range(0, 300).Select(i => (object?)(long)(i / 3))).ToList()),
            "int, 31 runs" or "int, 32 runs" or "int, 33 runs" or "int, 40 runs" => Runs(int.Parse(name[5..7], System.Globalization.CultureInfo.InvariantCulture)),
            "decimal forms, almost in order" => (JazminType.Decimal, Enumerable.Range(0, n).Select(i => (object?)(i / 2 / 100m).ToString(i % 3 == 0 ? "F2" : "F3", System.Globalization.CultureInfo.InvariantCulture)).Concat(["1.5", "1.50", "1.500", "0.10", "0.1"]).ToList()),
            "decimal forms in runs" => (JazminType.Decimal, Enumerable.Range(0, 5).SelectMany(r => Enumerable.Range(0, 400).Select(i => (object?)(i / 100m).ToString($"F{2 + (i + r) % 3}", System.Globalization.CultureInfo.InvariantCulture))).ToList()),
            _ => throw new ArgumentOutOfRangeException(nameof(name)),
        };

        static (JazminType, List<object?>) Runs(int runs) =>
            (JazminType.Int, Enumerable.Range(0, runs).SelectMany(r => Enumerable.Range(0, 100).Select(i => (object?)(long)((i * runs + r) % 2500))).ToList());
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Pages_are_the_same_as_the_reference_builders(string name)
    {
        var (type, values) = Data(name);
        var builder = new SortedIndexBuilder(type);
        var reference = new ReferenceBuilder(type);
        var nulls = new List<long>();
        for (var row = 0; row < values.Count; row++)
        {
            builder.Add(row, values[row]);
            reference.Add(row, values[row]);
            if (values[row] is null) nulls.Add(row);
        }
        foreach (var pageBytes in new[] { 64, 4096, 1 << 20 })
        {
            var expected = reference.Pages(pageBytes);
            var actual = builder.Pages(pageBytes).ToList();
            Assert.Equal(expected.Count, actual.Count);
            for (var i = 0; i < expected.Count; i++)
            {
                Assert.Equal(expected[i].First, actual[i].First);
                Assert.Equal(expected[i].Count, actual[i].Count);
                Assert.Equal(expected[i].Raw, actual[i].Raw);
            }
        }
        Assert.Equal(nulls, builder.Nulls);
    }
}
