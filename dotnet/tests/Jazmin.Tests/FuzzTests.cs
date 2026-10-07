using System.Diagnostics;
using System.Text.Json.Nodes;
using Jazmin.Format;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Damaged files fail with a <see cref="JazminException"/> (TASKS S-5): never another exception, a hang or a runaway
/// allocation. Short runs with fixed seeds; <see cref="LongRun"/> fuzzes for JAZMIN_FUZZ_MINUTES when that is set.
/// Mirrors js/test/fuzz-helpers.js. spec/fixtures/damaged holds inputs that once failed with another error.
/// </summary>
public class FuzzTests
{
    private static readonly Lazy<List<byte[]>> Corpus = new(Fuzzing.Corpus);

    [Fact]
    public void FilesDamagedInWaysThatOnceCrashedAReader_FailWithJazminException()
    {
        var names = Directory.GetFiles(Path.Combine(Fuzzing.Fixtures, "damaged"), "*.jzm");
        Assert.True(names.Length >= 15);
        foreach (var name in names)
        {
            var error = Fuzzing.Exercise(File.ReadAllBytes(name));
            Assert.True(error is null, $"{Path.GetFileName(name)}: {error}");
        }
    }

    [Fact]
    public void Corpus_ReadsEveryWayWithoutErrors()
    {
        foreach (var file in Corpus.Value)
        {
            var error = Fuzzing.Exercise(file, strict: true);
            Assert.True(error is null, error?.ToString());
        }
    }

    [Fact]
    public void RandomlyDamagedFiles_FailWithJazminException()
    {
        for (var seed = 1; seed <= 400; seed++)
        {
            var bytes = Fuzzing.Input(Corpus.Value, Fuzzing.Payloads(Corpus.Value), seed, decoders: false).Bytes;
            var error = Fuzzing.Exercise(bytes);
            Assert.True(error is null, $"seed {seed}: {error}");
        }
    }

    [Fact]
    public void SectionDecoders_RejectDamagedPayloadsWithJazminException()
    {
        var payloads = Fuzzing.Payloads(Corpus.Value);
        for (var seed = 1; seed <= 400; seed++)
        {
            var bytes = Fuzzing.Input(Corpus.Value, payloads, seed, decoders: true).Bytes;
            var error = Fuzzing.ExerciseDecoders(bytes, seed);
            Assert.True(error is null, $"seed {seed}: {error}");
        }
    }

    /// <summary>
    /// Long run: JAZMIN_FUZZ_MINUTES=60 [JAZMIN_FUZZ_SEED=1] [JAZMIN_FUZZ_OUT=dir] dotnet test --filter LongRun.
    /// Failing inputs are written to the output folder as seed-n.bin / seed-n.txt; a hang (no progress for 15 s) stops the run.
    /// </summary>
    [Fact]
    public void LongRun()
    {
        if (!double.TryParse(Environment.GetEnvironmentVariable("JAZMIN_FUZZ_MINUTES"), out var minutes)) return;
        var first = int.TryParse(Environment.GetEnvironmentVariable("JAZMIN_FUZZ_SEED"), out var s) ? s : 1;
        var outDir = Environment.GetEnvironmentVariable("JAZMIN_FUZZ_OUT") ?? Path.Combine(Path.GetTempPath(), "jazmin-fuzz");
        Directory.CreateDirectory(outDir);
        var corpus = Corpus.Value;
        var payloads = Fuzzing.Payloads(corpus);
        var deadline = Stopwatch.StartNew();
        long current = first, done = 0;
        var findings = 0;
        void Save(int seed, Fuzzing.FuzzInput input, string message)
        {
            Interlocked.Increment(ref findings);
            File.WriteAllBytes(Path.Combine(outDir, $"seed-{seed}.bin"), input.Bytes);
            File.WriteAllText(Path.Combine(outDir, $"seed-{seed}.txt"), $"{(input.Decoders ? "decoders" : "file")}\n{message}\n");
        }
        var worker = new Thread(() =>
        {
            for (var seed = first; deadline.Elapsed.TotalMinutes < minutes; seed++)
            {
                Interlocked.Exchange(ref current, seed);
                var input = Fuzzing.Input(corpus, payloads, seed, decoders: null);
                var error = input.Decoders ? Fuzzing.ExerciseDecoders(input.Bytes, seed) : Fuzzing.Exercise(input.Bytes);
                if (error is not null) Save(seed, input, error.ToString());
                Interlocked.Increment(ref done);
            }
        }) { IsBackground = true };
        worker.Start();
        var last = (Done: -1L, At: Stopwatch.StartNew());
        while (!worker.Join(1000))
        {
            var count = Interlocked.Read(ref done);
            if (count != last.Done) last = (count, Stopwatch.StartNew());
            else if (last.At.Elapsed.TotalSeconds > 15)
            {
                var seed = (int)Interlocked.Read(ref current);
                Save(seed, Fuzzing.Input(corpus, payloads, seed, decoders: null), "hang: no progress for 15 s");
                break;
            }
        }
        Assert.True(findings == 0, $"{findings} finding(s) in {outDir} after {Interlocked.Read(ref done):N0} inputs from seed {first}");
    }
}

/// <summary>Builds damaged inputs and reads them every way a caller might. Mirrors js/test/fuzz-helpers.js.</summary>
internal static class Fuzzing
{
    public static readonly string Fixtures = FindFixtures();

    private static string FindFixtures()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "spec", "fixtures");
            if (File.Exists(Path.Combine(candidate, "dataset.json"))) return candidate;
        }
        throw new InvalidOperationException("spec/fixtures not found");
    }

    /// <summary>Small deterministic generator (mulberry32, as in the JavaScript fuzzer).</summary>
    public sealed class Random(int seed)
    {
        private uint _a = unchecked((uint)seed);

        public double Next()
        {
            unchecked
            {
                _a += 0x6d2b79f5;
                var t = _a;
                t = (t ^ (t >> 15)) * (t | 1);
                t ^= t + (t ^ (t >> 7)) * (t | 61);
                return (t ^ (t >> 14)) / 4294967296.0;
            }
        }

        public int Int(int n) => (int)(Next() * n);

        public T Pick<T>(IReadOnlyList<T> list) => list[Int(list.Count)];
    }

    public sealed record FuzzInput(byte[] Bytes, bool Decoders);

    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("name", JazminType.String) { Indexes = [JazminIndexKind.Sorted, JazminIndexKind.Trigram] },
        new("amount", JazminType.Decimal) { Indexes = [JazminIndexKind.Sorted] },
        new("score", JazminType.Float),
        new("active", JazminType.Bool),
        new("when", JazminType.DateTime),
        new("blob", JazminType.Binary),
        new("extra", JazminType.Json),
    };

    private static object?[] Row(int i) =>
    [
        i == 119 ? 1L << 62 : i,
        i % 9 == 0 ? null : $"Person {i % 23} {string.Concat(Enumerable.Repeat("ab", i % 4))}",
        i % 7 == 0 ? null : $"{i}.{i % 100:00}",
        i % 11 == 0 ? null : i % 13 == 0 ? -0.0 : i / 3.0,
        i % 5 == 0 ? null : i % 2 == 0,
        i % 6 == 0 ? null : new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddHours(i),
        i % 4 == 0 ? null : new byte[] { (byte)i, 1, 2 },
        i % 8 == 0 ? null : JsonNode.Parse($"{{\"i\":{i},\"list\":[{i % 3},\"x\"]}}"),
    ];

    private static byte[] Write(int rows, JazminCodec codec, int chunkRows = 16, bool files = false)
    {
        var stream = new MemoryStream();
        var options = new JazminWriteOptions
        {
            Codec = codec, ChunkRows = chunkRows, SortedBy = ["id"], IndexPageBytes = 96,
            Metadata = new JsonObject { ["title"] = "fuzz", ["n"] = 1 },
        };
        if (files)
        {
            options.Files = [new JazminFileInput("index.html", "<p>x</p>"u8.ToArray()), new JazminFileInput("a/b.bin", Enumerable.Repeat((byte)7, 300).ToArray())];
            options.Package = new JazminPackage { Entry = "index.html", Title = "Fuzz" };
        }
        using (var writer = new JazminWriter(stream, Columns, options, leaveOpen: true))
            for (var i = 0; i < rows; i++) writer.WriteValues(Row(i));
        return stream.ToArray();
    }

    /// <summary>Plain files covering the reader's features, written by this library, plus the plain fixtures written by JavaScript.</summary>
    public static List<byte[]> Corpus()
    {
        var files = new List<byte[]>
        {
            Write(120, JazminCodec.None), Write(120, JazminCodec.Deflate), Write(40, JazminCodec.Brotli, chunkRows: 64),
            Write(120, JazminCodec.None, files: true),
        };
        var path = Path.Combine(Path.GetTempPath(), $"jazmin-fuzz-{Guid.NewGuid():N}.jzm");
        try
        {
            File.WriteAllBytes(path, Write(80, JazminCodec.None));
            var names = Columns.Select(c => c.Name).ToArray();
            JazminFile.Append(path, new JazminAppend
            {
                Insert = Enumerable.Range(80, 40).Select(i => (IReadOnlyDictionary<string, object?>)names.Zip(Row(i)).ToDictionary(p => p.First, p => p.Second)).ToList(),
                Delete = JazminFilter.Lt("id", 10L),
                Codec = JazminCodec.None,
            });
            files.Add(File.ReadAllBytes(path));
        }
        finally
        {
            File.Delete(path);
        }
        foreach (var name in new[] { "js-plain.jzm", "js-brotli.jzm", "js-appended.jzm" }) files.Add(File.ReadAllBytes(Path.Combine(Fixtures, name)));
        return files;
    }

    /// <summary>Section boundaries (the payload follows a 16-byte envelope); the trailers of earlier versions are skipped.</summary>
    public static List<(int At, int Length)> Sections(byte[] buf)
    {
        var list = new List<(int, int)>();
        var at = 64;
        var end = buf.Length - 44;
        while (at + 16 <= end)
        {
            if (buf.AsSpan(at + 40, 4).SequenceEqual("JZM1"u8) && Crc32.Compute(buf.AsSpan(at, 36)) == BitConverter.ToUInt32(buf, at + 36))
            {
                at += 44;
                continue;
            }
            var length = (int)BitConverter.ToUInt32(buf, at + 8);
            if (length < 0 || at + 16 + (long)length > end) break;
            list.Add((at, length));
            at += 16 + length;
        }
        return list;
    }

    /// <summary>Decoded payloads of the corpus's sections (compressed payloads that need their real section id are skipped).</summary>
    public static List<byte[]> Payloads(List<byte[]> files)
    {
        var payloads = new List<byte[]>();
        foreach (var file in files)
        {
            foreach (var (at, length) in Sections(file))
            {
                try
                {
                    payloads.Add(SectionCodec.Decode(file.AsSpan(at, 16 + length).ToArray(), null, new byte[16], "x"));
                }
                catch (JazminException)
                {
                }
            }
        }
        return payloads;
    }

    private static readonly byte[] Special = [0x00, 0x01, 0x7f, 0x80, 0xff, 0x0a, 0x12, 0x08];

    private static void FixSectionCrc(byte[] buf, (int At, int Length) s) =>
        BitConverter.TryWriteBytes(buf.AsSpan(s.At + 12), Crc32.Compute(buf.AsSpan(s.At + 16, s.Length)));

    private static void Damage(byte[] buf, int start, int length, Random rnd)
    {
        if (start < 0 || length <= 0 || start + length > buf.Length) return;
        var at = start + rnd.Int(length);
        switch (rnd.Int(6))
        {
            case 0: buf[at] ^= (byte)(1 << rnd.Int(8)); break;
            case 1: buf[at] = rnd.Pick(Special); break;
            case 2: for (var i = at; i < Math.Min(start + length, at + 1 + rnd.Int(9)); i++) buf[i] = 0xff; break; // huge varint
            case 3: for (var i = at; i < Math.Min(start + length, at + 1 + rnd.Int(16)); i++) buf[i] = (byte)rnd.Int(256); break;
            case 4:
            {
                var from = start + rnd.Int(length);
                var n = Math.Min(rnd.Int(24) + 1, start + length - Math.Max(at, from));
                if (n > 0) Buffer.BlockCopy(buf, from, buf, at, n);
                break;
            }
            default: buf[at] = (byte)(buf[at] + (rnd.Next() < 0.5 ? 1 : -1)); break;
        }
    }

    /// <summary>A damaged copy of <paramref name="file"/>.</summary>
    public static byte[] Mutate(byte[] file, Random rnd)
    {
        var buf = (byte[])file.Clone();
        var list = Sections(buf);
        var op = rnd.Next();
        if (op < 0.6 && list.Count > 0)
        {
            for (var k = 1 + (rnd.Next() < 0.3 ? rnd.Int(4) : 0); k > 0; k--)
            {
                var s = rnd.Pick(list);
                Damage(buf, s.At + 16, s.Length, rnd);
                FixSectionCrc(buf, s);
            }
        }
        else if (op < 0.7 && list.Count > 0)
        {
            var s = rnd.Pick(list);
            Damage(buf, s.At, 8, rnd); // codec, flags, raw length
        }
        else if (op < 0.8)
        {
            if (buf.Length < 108) return buf;
            Damage(buf, buf.Length - 44, 36, rnd); // trailer offsets and lengths
            BitConverter.TryWriteBytes(buf.AsSpan(buf.Length - 8), Crc32.Compute(buf.AsSpan(buf.Length - 44, 36)));
        }
        else if (op < 0.87)
        {
            return buf[..rnd.Int(buf.Length)]; // truncated
        }
        else if (op < 0.93)
        {
            Damage(buf, 0, 64, rnd); // preamble
        }
        else if (list.Count > 1)
        {
            var a = rnd.Pick(list);
            var b = rnd.Pick(list);
            Buffer.BlockCopy(buf, b.At + 16, buf, a.At + 16, Math.Min(a.Length, b.Length));
            FixSectionCrc(buf, a);
        }
        return buf;
    }

    /// <summary>The input for one seed: a damaged file, or a damaged raw section payload (one in four when <paramref name="decoders"/> is null).</summary>
    public static FuzzInput Input(List<byte[]> files, List<byte[]> payloads, int seed, bool? decoders)
    {
        var rnd = new Random(seed);
        if (decoders ?? rnd.Next() < 0.25)
        {
            var raw = (byte[])rnd.Pick(payloads).Clone();
            for (var k = 1 + rnd.Int(3); k > 0 && raw.Length > 0; k--)
            {
                var at = rnd.Int(raw.Length);
                raw[at] = rnd.Next() < 0.5 ? (byte)rnd.Int(256) : (byte)(raw[at] ^ (1 << rnd.Int(8)));
            }
            if (rnd.Next() < 0.1) raw = raw[..rnd.Int(raw.Length + 1)];
            return new FuzzInput(raw, true);
        }
        var bytes = rnd.Pick(files);
        for (var k = 1 + (rnd.Next() < 0.2 ? rnd.Int(3) : 0); k > 0; k--) bytes = Mutate(bytes, rnd);
        return new FuzzInput(bytes, false);
    }

    private static readonly JazminFilter?[] Filters =
    {
        null, JazminFilter.Eq("id", 5L), JazminFilter.Gte("id", 30L) & JazminFilter.Lt("id", 60L), JazminFilter.Contains("name", "son 1"),
        JazminFilter.StartsWith("name", "Person 2"), JazminFilter.Gt("amount", "10.5"), JazminFilter.Eq("amount", "12.12"),
        JazminFilter.Lt("score", 10.0), JazminFilter.Eq("active", true), JazminFilter.IsNull("when"),
        JazminFilter.Lt("id", 3L) | JazminFilter.IContains("name", "AB"),
    };

    private sealed class TypedRow
    {
        public long Id { get; set; }
        public string? Name { get; set; }
        public string? Amount { get; set; }
        public double? Score { get; set; }
        public bool? Active { get; set; }
        public DateTime? When { get; set; }
        public byte[]? Blob { get; set; }
        public JsonNode? Extra { get; set; }
    }

    private static void Touch(JazminRow row)
    {
        foreach (var pair in row) _ = pair.Value;
    }

    private static void Attempt(Action action, bool strict)
    {
        try
        {
            action();
        }
        catch (JazminException) when (!strict)
        {
        }
    }

    /// <summary>Reads a (possibly damaged) file every way a caller might. Returns null, or the unexpected exception.</summary>
    public static Exception? Exercise(byte[] buf, bool strict = false)
    {
        try
        {
            using var r = JazminReader.Open(buf);
            _ = r.Columns;
            _ = r.Metadata;
            _ = r.Indexes;
            _ = r.SortedBy;
            _ = r.Package;
            var corpusColumns = r.Columns.Select(c => c.Name).SequenceEqual(Columns.Select(c => c.Name));
            foreach (var filter in Filters)
            {
                if (filter is not null && !corpusColumns) continue;
                Attempt(() =>
                {
                    r.Explain(filter);
                    foreach (var row in r.Find(filter, new JazminQueryOptions { Limit = 40 })) Touch(row);
                }, strict);
            }
            var n = r.RowCount;
            if (n > 0 && !strict)
            {
                foreach (var id in new[] { 0, n / 2, n - 1 }) Attempt(() => Touch(r.Get(id)), strict);
            }
            foreach (var f in r.Files)
            {
                Attempt(() =>
                {
                    r.ReadFile(f.Path);
                    r.ReadFileRange(f.Path, 1, 20);
                }, strict);
            }
            Attempt(() =>
            {
                foreach (var row in r.Rows(new JazminQueryOptions { Select = r.Columns.Take(2).Select(c => c.Name).ToList() })) Touch(row);
            }, strict);
            if (corpusColumns) Attempt(() => r.Rows<TypedRow>().Count(), strict);
            return null;
        }
        catch (JazminException) when (!strict)
        {
            return null;
        }
        catch (Exception error)
        {
            return error;
        }
    }

    /// <summary>Decoders on their own, with damaged input; their arguments come from <paramref name="seed"/>. Returns null, or the unexpected exception.</summary>
    public static Exception? ExerciseDecoders(byte[] input, int seed)
    {
        var rnd = new Random(seed ^ 0x5bd1e995);
        var types = Enum.GetValues<JazminType>();
        var first12 = input.AsSpan(0, Math.Min(12, input.Length)).ToArray();
        var attempts = new Action[]
        {
            () => Catalog.DecodeHeader(input),
            () => Catalog.DecodeChunkDirectoryLists(input, 1 + rnd.Int(3)),
            () => Catalog.DecodeChunkDirectory(input, 1 + rnd.Int(3)),
            () => Catalog.DecodeStatistics(input),
            () => Catalog.DecodeIndexDirectory(input),
            () => Catalog.DecodePartitionTable(input),
            () => Catalog.FindPartitions(input, [first12]),
            () => Catalog.DecodeDelta(input),
            () => Catalog.DecodeOwnerCatalog(input, 0),
            () => Catalog.JoinChunkMaps(Catalog.DecodeChunkMap(input), Catalog.DecodeChunkMap(input.AsSpan(input.Length / 2).ToArray())),
            () => Catalog.DecodeColumnDefinitions(input),
            () => Columnar.Decode(input, Enumerable.Range(0, 1 + rnd.Int(4)).Select(_ => rnd.Pick(types)).ToArray(), rnd.Int(300), 0),
            () => Columnar.DecodeTyped(input, input.Length, Enumerable.Range(0, 1 + rnd.Int(4)).Select(_ => rnd.Pick(types)).ToArray(), rnd.Int(300), 0),
            () => SortedIndex.DecodePage(input, rnd.Pick(types)),
            () => SortedIndex.DecodePage(input, rnd.Pick(types), deltas: true), // keys as differences (reader feature index-deltas)
            () => TrigramIndex.Decode(input),
            () => RowSet.DecodeSection(input, "Rows"),
            () => AccessCrypto.FindKeySlotPage(input, input.AsSpan(0, Math.Min(8, input.Length))),
            () => AccessCrypto.UnsealSlot(AccessCrypto.ParseKeySlots(input), new byte[32], new byte[32], new byte[16]),
            () => SectionCodec.Decode(input, null, new byte[16], "x"),
        };
        foreach (var attempt in attempts)
        {
            try
            {
                attempt();
            }
            catch (JazminException)
            {
            }
            catch (Exception error)
            {
                return error;
            }
        }
        return null;
    }
}
