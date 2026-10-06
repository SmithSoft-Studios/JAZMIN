using System.Text.Json;
using System.Text.Json.Nodes;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// The compiled row -> object code is reused across readers whose files have the same columns (issue #70), and never
/// for a file whose columns differ in names, types or order. The types are used only here, so the counts are exact.
/// </summary>
public class MaterializerCacheTests
{
    public sealed class Target
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public double Score { get; set; }
    }

    // The same names in another order, and Score stored as an integer instead of a float.
    public sealed class LayoutA { public int Id { get; set; } public string Name { get; set; } = ""; public double Score { get; set; } }
    public sealed class Swapped { public string Name { get; set; } = ""; public int Id { get; set; } public double Score { get; set; } }
    public sealed class IntScore { public int Id { get; set; } public string Name { get; set; } = ""; public int Score { get; set; } }

    private static byte[] FileA(int offset) => JazminConvert.SerializeObject(
        Enumerable.Range(0, 50).Select(i => new LayoutA { Id = i + offset, Name = $"a{i + offset}", Score = i + offset + 0.5 }).ToList());

    private static byte[] FileSwapped(int offset) => JazminConvert.SerializeObject(
        Enumerable.Range(0, 50).Select(i => new Swapped { Id = i + offset, Name = $"s{i + offset}", Score = i + offset + 0.25 }).ToList());

    private static byte[] FileIntScore(int offset) => JazminConvert.SerializeObject(
        Enumerable.Range(0, 50).Select(i => new IntScore { Id = i + offset, Name = $"n{i + offset}", Score = i + offset }).ToList());

    private static int Compilations<T>() => TypeMap.For(typeof(T)).Compilations;

    private static Target Lookup(byte[] file, int id)
    {
        using var reader = JazminReader.Open(file);
        return reader.Query<Target>(x => x.Id == id).Single();
    }

    public sealed class LookupOnly { public int Id { get; set; } public string Name { get; set; } = ""; public double Score { get; set; } }
    public sealed class ReadAllOnly { public int Id { get; set; } public string Name { get; set; } = ""; public double Score { get; set; } }

    [Fact]
    public void Readers_of_files_with_the_same_columns_share_the_compiled_code()
    {
        var first = FileA(0);
        var second = FileA(1000); // other values, same columns
        using (var reader = JazminReader.Open(first)) Assert.Equal("a7", reader.Query<LookupOnly>(x => x.Id == 7).Single().Name);
        var lookups = Compilations<LookupOnly>();
        Assert.True(lookups >= 1);
        for (var i = 0; i < 5; i++)
        {
            using var reader = JazminReader.Open(i % 2 == 0 ? first : second);
            var id = i % 2 == 0 ? 3 : 1003;
            var found = reader.Query<LookupOnly>(x => x.Id == id).Single();
            Assert.Equal((id, $"a{id}", id + 0.5), (found.Id, found.Name, found.Score));
        }
        Assert.Equal(lookups, Compilations<LookupOnly>());

        // Reading every row: each call opens its own reader, with its own default settings.
        Assert.Equal(50, JazminConvert.DeserializeObject<List<ReadAllOnly>>(first)!.Count);
        var readAll = Compilations<ReadAllOnly>();
        for (var i = 0; i < 5; i++)
        {
            var rows = JazminConvert.DeserializeObject<List<ReadAllOnly>>(i % 2 == 0 ? first : second)!;
            var offset = i % 2 == 0 ? 0 : 1000;
            Assert.Equal(Enumerable.Range(offset, 50), rows.Select(r => r.Id));
            Assert.Equal(offset + 49.5, rows[^1].Score);
        }
        Assert.Equal(readAll, Compilations<ReadAllOnly>());
    }

    [Fact]
    public void Files_whose_columns_differ_in_order_or_type_read_correctly_in_any_order()
    {
        var a = FileA(0);
        var swapped = FileSwapped(0);
        var intScore = FileIntScore(0);
        using (var check = JazminReader.Open(swapped)) Assert.Equal(["Name", "Id", "Score"], check.Columns.Select(c => c.Name));
        using (var check = JazminReader.Open(intScore)) Assert.Equal(JazminType.Int, check.Columns.Single(c => c.Name == "Score").Type);

        for (var round = 0; round < 3; round++)
        {
            Assert.Equal(("a7", 7.5), (Lookup(a, 7).Name, Lookup(a, 7).Score));
            Assert.Equal(("s7", 7.25), (Lookup(swapped, 7).Name, Lookup(swapped, 7).Score));
            Assert.Equal(("n7", 7.0), (Lookup(intScore, 7).Name, Lookup(intScore, 7).Score));

            Assert.Equal("a9", JazminConvert.DeserializeObject<List<Target>>(a)![9].Name);
            Assert.Equal(("s9", 9.25), JazminConvert.DeserializeObject<List<Target>>(swapped)![9] is var s ? (s.Name, s.Score) : default);
            Assert.Equal(("n9", 9.0), JazminConvert.DeserializeObject<List<Target>>(intScore)![9] is var n ? (n.Name, n.Score) : default);
        }
    }

    public sealed class Inner { public int Value { get; set; } }
    public sealed class WithJson { public int Id { get; set; } public Inner? Payload { get; set; } }
    public sealed class WithJsonStored { public int Id { get; set; } public JsonNode? Payload { get; set; } }

    [Fact]
    public void Shared_code_still_uses_each_call_s_own_settings()
    {
        // A json column holding {"value": 5}: only case-insensitive JSON options fill Inner.Value.
        var file = JazminConvert.SerializeObject(new List<WithJsonStored> { new() { Id = 1, Payload = JsonNode.Parse("{\"value\": 5}") } });
        var insensitive = new JazminSerializerSettings { JsonOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true } };
        for (var i = 0; i < 2; i++)
        {
            Assert.Equal(0, JazminConvert.DeserializeObject<List<WithJson>>(file)![0].Payload!.Value);
            Assert.Equal(5, JazminConvert.DeserializeObject<List<WithJson>>(file, insensitive)![0].Payload!.Value);
            using var reader = JazminReader.Open(file);
            Assert.Equal(0, reader.Query<WithJson>(x => x.Id == 1).Single().Payload!.Value);
            Assert.Equal(5, reader.Query<WithJson>(x => x.Id == 1, insensitive).Single().Payload!.Value);
        }
    }

    public sealed class Concurrent { public int Id { get; set; } public string Name { get; set; } = ""; public double Score { get; set; } }

    [Fact]
    public void Readers_on_many_threads_with_different_columns_read_correct_values()
    {
        var files = new (byte[] File, string Prefix, double Fraction)[] { (FileA(0), "a", 0.5), (FileSwapped(0), "s", 0.25), (FileIntScore(0), "n", 0.0) };
        Parallel.For(0, 300, new ParallelOptions { MaxDegreeOfParallelism = 8 }, i =>
        {
            var (file, prefix, fraction) = files[i % files.Length];
            var id = i % 50;
            if (i % 2 == 0)
            {
                using var reader = JazminReader.Open(file);
                var found = reader.Query<Concurrent>(x => x.Id == id).Single();
                Assert.Equal(($"{prefix}{id}", id + fraction), (found.Name, found.Score));
            }
            else
            {
                var rows = JazminConvert.DeserializeObject<List<Concurrent>>(file)!;
                Assert.Equal(($"{prefix}{id}", id + fraction), (rows[id].Name, rows[id].Score));
            }
        });
    }
}
