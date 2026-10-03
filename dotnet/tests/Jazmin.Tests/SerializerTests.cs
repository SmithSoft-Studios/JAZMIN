using System.ComponentModel;
using System.Text.Json.Serialization;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

public enum Tier { Bronze, Silver, Gold }

public class Person
{
    [JazminIndex]
    public int Id { get; set; }

    [JazminIndex(JazminIndexKind.Sorted, JazminIndexKind.Trigram)]
    [Description("Full name")]
    public string Name { get; set; } = "";

    [JazminProperty("country_code")]
    public string? Country { get; set; }

    public Tier Tier { get; set; }

    public decimal Balance { get; set; }

    public double? Score { get; set; }

    public DateTime Joined { get; set; }

    public Guid Ref { get; set; }

    public List<string> Tags { get; set; } = new();

    [JazminIgnore]
    public string Secret { get; set; } = "not stored";

    [JsonIgnore]
    public string AlsoIgnored { get; set; } = "not stored";
}

public record PersonRecord(int Id, string Name, string? Country_Code);

public class SerializerTests
{
    private static List<Person> People(int count = 300) => Enumerable.Range(0, count).Select(i => new Person
    {
        Id = i,
        Name = i % 5 == 0 ? $"Ann Johnson {i}" : $"Bob Smith {i}",
        Country = i % 10 == 0 ? null : i % 2 == 0 ? "ZA" : "NA",
        Tier = (Tier)(i % 3),
        Balance = 1000.25m + i,
        Score = i % 4 == 0 ? null : i * 0.5,
        Joined = new DateTime(2023, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddHours(i),
        Ref = new Guid(i, 0, 0, new byte[8]),
        Tags = new List<string> { "t" + i % 3 },
    }).ToList();

    [Fact]
    public void SerializeObject_DeserializeObject_LikeNewtonsoft()
    {
        var people = People();
        var bytes = JazminConvert.SerializeObject(people);
        var back = JazminConvert.DeserializeObject<List<Person>>(bytes)!;

        Assert.Equal(people.Count, back.Count);
        for (var i = 0; i < people.Count; i++)
        {
            Assert.Equal(people[i].Id, back[i].Id);
            Assert.Equal(people[i].Name, back[i].Name);
            Assert.Equal(people[i].Country, back[i].Country);
            Assert.Equal(people[i].Tier, back[i].Tier);
            Assert.Equal(people[i].Balance, back[i].Balance);
            Assert.Equal(people[i].Score, back[i].Score);
            Assert.Equal(people[i].Joined, back[i].Joined);
            Assert.Equal(people[i].Ref, back[i].Ref);
            Assert.Equal(people[i].Tags, back[i].Tags);
            Assert.Equal("not stored", back[i].Secret);
        }
    }

    [Fact]
    public void Attributes_ShapeTheSchema()
    {
        using var reader = JazminReader.Open(JazminConvert.SerializeObject(People(3)));
        var names = reader.Columns.Select(c => c.Name).ToList();
        Assert.Contains("country_code", names);
        Assert.DoesNotContain("Secret", names);
        Assert.DoesNotContain("AlsoIgnored", names);
        Assert.Equal("Full name", reader.Columns.Single(c => c.Name == "Name").Description);
        Assert.Contains(("Name", JazminIndexKind.Trigram), reader.Indexes);
        Assert.Equal(JazminType.Json, reader.Columns.Single(c => c.Name == "Tags").Type);
    }

    [Fact]
    public void SingleObject_ArraysAndRecords()
    {
        var one = JazminConvert.DeserializeObject<Person>(JazminConvert.SerializeObject(People(1)[0]))!;
        Assert.Equal("Ann Johnson 0", one.Name);

        var array = JazminConvert.DeserializeObject<Person[]>(JazminConvert.SerializeObject(People(5)))!;
        Assert.Equal(5, array.Length);

        var records = JazminConvert.DeserializeObject<List<PersonRecord>>(JazminConvert.SerializeObject(People(3)))!;
        Assert.Equal(new PersonRecord(1, "Bob Smith 1", "NA"), records[1]);
    }

    [Fact]
    public void Untyped_Dictionaries()
    {
        var rows = new List<Dictionary<string, object?>>
        {
            new() { ["a"] = 1, ["b"] = "x" },
            new() { ["a"] = 2.5, ["c"] = true },
        };
        var back = JazminConvert.DeserializeObject(JazminConvert.SerializeObject(rows));
        Assert.Equal(2.5, back[1]["a"]);
        Assert.Null(back[1]["b"]);
        Assert.Equal(true, back[1]["c"]);
    }

    [Fact]
    public void EncryptedSettings()
    {
        var settings = new JazminSerializerSettings { Password = "pw", KdfIterations = 1000 };
        var bytes = JazminConvert.SerializeObject(People(10), settings);
        Assert.Equal(10, JazminConvert.DeserializeObject<List<Person>>(bytes, settings)!.Count);
        Assert.Throws<JazminKeyException>(() => JazminConvert.DeserializeObject<List<Person>>(bytes));
    }

    [Fact]
    public void DeserializeEnumerable_Streams()
    {
        var stream = new MemoryStream(JazminConvert.SerializeObject(People()));
        Assert.Equal(new[] { 0, 1, 2 }, new JazminSerializer().DeserializeEnumerable<Person>(stream).Take(3).Select(p => p.Id));
    }
}

public class LinqTests
{
    private static readonly List<Person> People = Enumerable.Range(0, 500).Select(i => new Person
    {
        Id = i,
        Name = i % 5 == 0 ? $"Ann Johnson {i}" : $"Bob Smith {i}",
        Country = i % 10 == 0 ? null : i % 2 == 0 ? "ZA" : "NA",
        Tier = (Tier)(i % 3),
        Balance = 10m + i,
        Score = i % 4 == 0 ? null : i * 0.5,
        Joined = new DateTime(2023, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddHours(i),
    }).ToList();

    private static readonly byte[] Bytes = JazminConvert.SerializeObject(People, new JazminSerializerSettings { ChunkRows = 50 });

    private static void Same(System.Linq.Expressions.Expression<Func<Person, bool>> predicate)
    {
        using var reader = JazminReader.Open(Bytes);
        var expected = People.Where(predicate.Compile()).Select(p => p.Id).ToList();
        Assert.Equal(expected, reader.Query(predicate).Select(p => p.Id).ToList());
    }

    [Fact]
    public void Comparisons() => Same(p => p.Id >= 100 && p.Id < 120);

    [Fact]
    public void FlippedOperands() => Same(p => 120 > p.Id);

    [Fact]
    public void NotEqual_IncludesNulls_LikeCSharp() => Same(p => p.Country != "ZA");

    [Fact]
    public void NullChecks() => Same(p => p.Country == null || p.Score == null);

    [Fact]
    public void Enums() => Same(p => p.Tier == Tier.Gold);

    [Fact]
    public void StringMethods() => Same(p => p.Name.Contains("Johnson") && p.Name.StartsWith("Ann"));

    [Fact]
    public void CapturedVariablesAndListContains()
    {
        var wanted = new List<string?> { "NA", null };
        var min = 400;
        Same(p => wanted.Contains(p.Country) && p.Id > min);
    }

    [Fact]
    public void Untranslatable_PartsStillApplied() => Same(p => p.Id % 7 == 0 && p.Country == "ZA");

    [Fact]
    public void Decimal_IsCheckedExactly() => Same(p => p.Balance > 300.5m);

    [Fact]
    public void Negation() => Same(p => !(p.Id < 490) && !(p.Country == "ZA"));

    [Fact]
    public void Dates() => Same(p => p.Joined >= new DateTime(2023, 1, 10, 0, 0, 0, DateTimeKind.Utc));

    [Fact]
    public void EnumRanges_UseNumericOrderLikeCSharp() => Same(p => p.Tier > Tier.Bronze && p.Tier < Tier.Gold);

    [Fact]
    public void CultureSensitiveStartsWith_IsNotNarrowedByIndex()
    {
        // A soft hyphen (U+00AD) is ignored by culture-aware StartsWith but not by an ordinal prefix match.
        var people = new List<Person> { new() { Id = 1, Name = "­Ann" }, new() { Id = 2, Name = "Bob" } };
        using var reader = JazminReader.Open(JazminConvert.SerializeObject(people));
        var expected = people.Where(p => p.Name.StartsWith("Ann")).Select(p => p.Id).ToList();
        Assert.Equal(expected, reader.Query<Person>(p => p.Name.StartsWith("Ann")).Select(p => p.Id).ToList());
        Assert.Equal(new[] { 1 }, reader.Query<Person>(p => p.Name.StartsWith("­A", StringComparison.Ordinal)).Select(p => p.Id));
    }

    [Fact]
    public void ExactTranslation_IsMarkedExact()
    {
        var id = 42;
        Assert.True(Query.ExpressionTranslator.Translate<Person>(p => p.Id == id && p.Country != "ZA", TypeMapFor<Person>()).Exact);
        Assert.False(Query.ExpressionTranslator.Translate<Person>(p => p.Id % 7 == 0 && p.Country == "ZA", TypeMapFor<Person>()).Exact);
        Assert.False(Query.ExpressionTranslator.Translate<Person>(p => p.Balance > 3m, TypeMapFor<Person>()).Exact);
    }

    [Fact]
    public void Translation_UsesIndex()
    {
        var filter = Query.ExpressionTranslator.Translate<Person>(p => p.Id == 42, TypeMapFor<Person>()).Filter;
        using var reader = JazminReader.Open(Bytes);
        Assert.Equal("index", reader.Explain(filter).Strategy);
    }

    private static Func<System.Reflection.MemberInfo, JazminColumn?> TypeMapFor<T>() => Serialization.TypeMap.For(typeof(T)).ColumnFor;
}
