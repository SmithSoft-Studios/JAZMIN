using System.Text.Json;
using Jazmin.Query;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Full reads into objects use a direct decoder (bytes straight into instances). These tests pin it
/// to the same results as the general row materializer.
/// </summary>
public class DirectReadTests
{
    public class PersonLite
    {
        public int ID { get; set; }               // column "Id": names match case-insensitively
        public string NAME { get; set; } = "";
        public string? Country_Code { get; set; } // column "country_code"
        public Tier Tier { get; set; }
        public double Score { get; set; }          // not nullable: a null value leaves the default
        public string Missing { get; set; } = "default"; // no such column
    }

    public class Narrow
    {
        public int Id { get; set; }
    }

    private static List<Person> People(int count) => Enumerable.Range(0, count).Select(i => new Person
    {
        Id = i,
        Name = $"Name {i % 7}",
        Country = i % 10 == 0 ? null : i % 2 == 0 ? "ZA" : "NA",
        Tier = (Tier)(i % 3),
        Balance = 10.5m * i,
        Score = i % 4 == 0 ? null : i * 0.25,
        Joined = new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMinutes(i),
        Ref = new Guid(i, 1, 2, new byte[8]),
        Tags = new List<string> { "t" + i % 3 },
    }).ToList();

    /// <summary>The general (pre-existing) path: rows materialized one by one.</summary>
    private static List<T> ViaRows<T>(byte[] bytes)
    {
        using var reader = JazminReader.Open(bytes);
        return reader.Rows().Select(r => (T)TypeMap.For(typeof(T)).FromRow(r, null)).ToList();
    }

    private static string Json<T>(IEnumerable<T> items) => JsonSerializer.Serialize(items);

    [Fact]
    public void DirectRead_MatchesTheRowMaterializer()
    {
        var bytes = JazminConvert.SerializeObject(People(10_000)); // several chunks
        Assert.Equal(Json(ViaRows<Person>(bytes)), Json(JazminConvert.DeserializeObject<List<Person>>(bytes)!));
        Assert.Equal(Json(ViaRows<PersonLite>(bytes)), Json(JazminConvert.DeserializeObject<List<PersonLite>>(bytes)!));
        Assert.Equal(Json(ViaRows<Narrow>(bytes)), Json(JazminConvert.DeserializeObject<List<Narrow>>(bytes)!));
    }

    [Fact]
    public void DirectRead_MapsNamesNullsAndMissingColumns()
    {
        var back = JazminConvert.DeserializeObject<List<PersonLite>>(JazminConvert.SerializeObject(People(12)))!;
        Assert.Equal(5, back[5].ID);
        Assert.Equal("Name 5", back[5].NAME);
        Assert.Equal("NA", back[5].Country_Code);
        Assert.Null(back[10].Country_Code);
        Assert.Equal(Tier.Silver, back[4].Tier);
        Assert.Equal(0, back[8].Score);          // stored null -> default for a non-nullable property
        Assert.Equal(1.25, back[5].Score);
        Assert.Equal("default", back[3].Missing);
    }

    [Fact]
    public void DirectRead_SkipsRowsDeletedByAnAppend()
    {
        var path = Path.Combine(Directory.CreateTempSubdirectory("jazmin-direct-").FullName, "people.jzm");
        new JazminSerializer().Serialize(path, People(100));
        JazminFile.Append(path, new JazminAppend { Delete = JazminFilter.Lt("Id", 10) });
        var back = new JazminSerializer().Deserialize<List<Person>>(path)!;
        Assert.Equal(90, back.Count);
        Assert.Equal(10, back[0].Id);
        Assert.Equal(Enumerable.Range(10, 90), new JazminSerializer().DeserializeEnumerable<Narrow>(File.OpenRead(path)).Select(p => p.Id));
    }

    [Fact]
    public void DirectRead_OverflowIsReportedLikeTheRowPath()
    {
        var rows = new[] { new Dictionary<string, object?> { ["Id"] = (long)int.MaxValue + 1 } };
        var bytes = JazminConvert.SerializeObject(rows);
        Assert.Throws<OverflowException>(() => ViaRows<Narrow>(bytes));
        Assert.Throws<OverflowException>(() => JazminConvert.DeserializeObject<List<Narrow>>(bytes));
    }

    [Fact]
    public void DirectRead_WorksForEncryptedFiles()
    {
        var key = JazminKey.Generate();
        var settings = new JazminSerializerSettings { Key = key };
        var bytes = JazminConvert.SerializeObject(People(50), settings);
        Assert.Equal(Json(People(50).Select(p => p.Id)), Json(JazminConvert.DeserializeObject<List<Person>>(bytes, settings)!.Select(p => p.Id)));
    }
}
