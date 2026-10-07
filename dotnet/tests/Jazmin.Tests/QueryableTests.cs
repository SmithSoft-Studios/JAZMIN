using Jazmin.Query;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>Counts the times its Name is set: a query that does not use Name must not read it.</summary>
public sealed class Probe
{
    public static int NamesSet;
    private string _name = "";

    public int Id { get; set; }

    public string Name
    {
        get => _name;
        set
        {
            _name = value;
            NamesSet++;
        }
    }

    public string? Country { get; set; }
}

/// <summary>
/// <c>reader.AsQueryable&lt;T&gt;()</c>: every query gives the results LINQ to Objects gives over the same list, and what
/// the reader can do, it does: conditions, Skip/Take, Count/Any, OrderBy along the sort order and reading only the
/// columns a query uses.
/// </summary>
public sealed class QueryableTests
{
    private static readonly List<Person> People = Enumerable.Range(0, 500).Select(i => new Person
    {
        Id = i,
        Name = i % 5 == 0 ? $"Ann Johnson {i}" : $"Bob Smith {i}",
        Country = i % 10 == 0 ? null : i % 2 == 0 ? "ZA" : "NA",
        Tier = (Tier)(i % 3),
        Balance = 10.25m + i,
        Score = i % 4 == 0 ? null : i * 0.5,
        Joined = new DateTime(2023, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddHours(i),
        Ref = new Guid(i, 0, 0, new byte[8]),
        Tags = ["t" + i % 3],
    }).ToList();

    /// <summary>Written by the serializer: indexes on Id and Name, no sort order.</summary>
    private static readonly byte[] Unsorted = JazminConvert.SerializeObject(People, new JazminSerializerSettings { ChunkRows = 50 });

    /// <summary>The same rows, sorted by Id, then Joined.</summary>
    private static readonly byte[] Sorted = Write(new JazminWriteOptions { SortedBy = ["Id", "Joined"], ChunkRows = 50 });

    private static byte[] Write(JazminWriteOptions options)
    {
        var path = Path.Combine(Path.GetTempPath(), $"jazmin-queryable-{Guid.NewGuid():N}.jzm");
        try
        {
            var map = TypeMap.For(typeof(Person));
            using (var writer = JazminWriter.Create(path, map.Columns, options))
                foreach (var person in People) writer.WriteValues(map.ToValues(person, null));
            return File.ReadAllBytes(path);
        }
        finally
        {
            File.Delete(path);
        }
    }

    /// <summary>Every stored property, so a row read with fewer columns than the caller receives is caught.</summary>
    private static string Describe(Person? p) =>
        p is null ? "null" : $"{p.Id}|{p.Name}|{p.Country}|{p.Tier}|{p.Balance}|{p.Score}|{p.Joined:O}|{p.Ref}|{string.Join(",", p.Tags)}";

    private static void Same<TResult>(Func<IQueryable<Person>, IEnumerable<TResult>> query, byte[]? file = null)
    {
        using var reader = JazminReader.Open(file ?? Unsorted);
        Assert.Equal(query(People.AsQueryable()).ToList(), query(reader.AsQueryable<Person>()).ToList());
    }

    private static void SameRows(Func<IQueryable<Person>, IQueryable<Person>> query, byte[]? file = null) =>
        Same(q => query(q).AsEnumerable().Select(Describe), file);

    private static void SameValue<TResult>(Func<IQueryable<Person>, TResult> query, byte[]? file = null)
    {
        using var reader = JazminReader.Open(file ?? Unsorted);
        Assert.Equal(query(People.AsQueryable()), query(reader.AsQueryable<Person>()));
    }

    private static void SameError(Func<IQueryable<Person>, object?> query)
    {
        var expected = Record.Exception(() => query(People.AsQueryable()));
        using var reader = JazminReader.Open(Unsorted);
        Assert.NotNull(expected);
        Assert.IsType(expected.GetType(), Record.Exception(() => query(reader.AsQueryable<Person>())));
    }

    [Fact]
    public void ConditionsSkipAndTake_GiveLinqToObjectsResults()
    {
        SameRows(q => q);
        SameRows(q => q.Where(p => p.Id >= 100 && p.Id < 300));
        SameRows(q => q.Where(p => p.Country == "ZA").Where(p => p.Tier == Tier.Gold));
        SameRows(q => q.Where(p => p.Id % 7 == 0 && p.Country != "NA")); // partly checked on each object
        SameRows(q => q.Where(p => p.Balance > 300.5m)); // decimals: checked on each object
        SameRows(q => q.Skip(120).Take(30));
        SameRows(q => q.Take(30).Skip(10));
        SameRows(q => q.Skip(10).Skip(5).Take(20).Take(7));
        SameRows(q => q.Skip(-5).Take(3));
        SameRows(q => q.Take(-1));
        SameRows(q => q.Skip(1000));
        SameRows(q => q.Where(p => p.Name.StartsWith("Ann", StringComparison.Ordinal)).Skip(3).Take(4));
        SameRows(q => q.Where(p => p.Id % 3 == 0).Skip(5).Take(7)); // Skip/Take after a check on each object
        SameRows(q => q.Skip(50).Where(p => p.Country == "ZA").Take(5)); // a condition after Skip sees what Skip left
        var (skip, take) = (40, 9);
        SameRows(q => q.Skip(skip).Take(take));
    }

    [Fact]
    public void Ordering_GivesLinqToObjectsResults_SortedOrNot()
    {
        foreach (var file in new[] { Unsorted, Sorted })
        {
            SameRows(q => q.OrderBy(p => p.Id).Skip(10).Take(5), file);
            SameRows(q => q.OrderBy(p => p.Id).ThenBy(p => p.Joined).Take(5), file);
            SameRows(q => q.OrderBy(p => p.Id).ThenByDescending(p => p.Joined).Take(5), file);
            SameRows(q => q.OrderByDescending(p => p.Id).Take(5), file);
            SameRows(q => q.OrderBy(p => p.Name).Take(5), file); // culture-sensitive: sorted in memory
            SameRows(q => q.OrderBy(p => p.Name, StringComparer.Ordinal).Take(5), file);
            SameRows(q => q.OrderBy(p => p.Score).ThenByDescending(p => p.Id).Take(9), file);
            SameRows(q => q.Where(p => p.Id % 4 == 1).OrderBy(p => p.Id).Skip(3), file);
            SameRows(q => q.Take(20).OrderBy(p => p.Id), file);
            SameRows(q => q.OrderBy(p => p.Joined).Where(p => p.Country == "NA").Take(6), file);
        }
    }

    [Fact]
    public void Projections_GiveLinqToObjectsResults()
    {
        Same(q => q.Select(p => p.Id));
        Same(q => q.Where(p => p.Country == "ZA").Select(p => new { p.Id, p.Name, p.Balance }).Skip(5).Take(10));
        Same(q => q.Select(p => new { p.Id, Upper = p.Name.ToUpperInvariant() }).Where(x => x.Id % 2 == 0).Take(10));
        Same(q => q.Select((p, i) => new { p.Id, i }).Skip(3).Take(4));
        Same(q => q.Where(p => p.Id % 9 == 0).Select(p => p.Tags.Count + p.Joined.Day + (p.Score ?? 0)));
        Same(q => q.Where(p => p.Id % 7 == 3).Select(p => new { p.Ref, p.Tier, p.Tags }).AsEnumerable().Select(x => $"{x.Ref}{x.Tier}{x.Tags[0]}"));
        SameRows(q => q.Select(p => p).Where(p => p.Id < 40));
    }

    [Fact]
    public void Answers_GiveLinqToObjectsResults()
    {
        SameValue(q => q.Count());
        SameValue(q => q.Count(p => p.Country == "ZA"));
        SameValue(q => q.Count(p => p.Id % 7 == 0));
        SameValue(q => q.Where(p => p.Id > 100).Skip(50).Take(500).LongCount());
        SameValue(q => q.Skip(490).Take(20).Count());
        SameValue(q => q.Select(p => p.Name).Count());
        SameValue(q => q.Take(0).Any());
        SameValue(q => q.Any(p => p.Id == 499));
        SameValue(q => q.Any(p => p.Id == 500));
        SameValue(q => q.Any(p => p.Id % 1000 == 999));
        SameValue(q => q.Skip(499).Any());
        SameValue(q => q.All(p => p.Id >= 0));
        SameValue(q => Describe(q.First(p => p.Name.Contains("Johnson") && p.Id > 200)));
        SameValue(q => Describe(q.FirstOrDefault(p => p.Id == 1234)));
        SameValue(q => Describe(q.Single(p => p.Id == 77)));
        SameValue(q => Describe(q.Last(p => p.Country == "NA")));
        SameValue(q => Describe(q.ElementAt(321)));
        SameValue(q => q.Sum(p => p.Balance));
        SameValue(q => q.Where(p => p.Country == "ZA").Average(p => p.Score));
        SameValue(q => q.Max(p => p.Joined));
        SameValue(q => q.Min(p => p.Name));
        SameValue(q => q.Select(p => p.Id).Max());
    }

    [Fact]
    public void Failures_AreLinqToObjectsFailures()
    {
        SameError(q => q.First(p => p.Id > 1000));
        SameError(q => q.Single(p => p.Country == "ZA"));
        SameError(q => q.ElementAt(999));
    }

    [Fact]
    public void OperatorsTheReaderCannotDo_RunInMemory()
    {
        (string Code, string Name)[] countries = [("ZA", "South Africa"), ("NA", "Namibia")];
        Same(q => q.Where(p => p.Id < 50).Join(countries, p => p.Country, c => c.Code, (p, c) => p.Id + c.Name));
        Same(q => q.GroupBy(p => p.Tier).Select(g => new { g.Key, Count = g.Count() }).OrderBy(x => x.Key));
        Same(q => q.Select(p => p.Country).Distinct());
        Same(q => q.Where(p => p.Id < 20).Join(q.Where(p => p.Id >= 10), a => a.Id, b => b.Id - 10, (a, b) => a.Id * 1000 + b.Id));
    }

    [Fact]
    public void Records_AreQueriedByTheirConstructorParameters()
    {
        using var reader = JazminReader.Open(Unsorted);
        var expected = People.Where(p => p.Id % 5 == 0 && p.Country == "NA").Select(p => p.Name).Take(5).ToList();
        Assert.Equal(expected, reader.AsQueryable<PersonRecord>().Where(r => r.Id % 5 == 0 && r.Country_Code == "NA").Select(r => r.Name).Take(5));
        Assert.Equal(People.Count(p => p.Country == "NA"), reader.AsQueryable<PersonRecord>().Count(r => r.Country_Code == "NA"));
    }

    [Fact]
    public void SharedFiles_AreQueriedWithAnAccessKey()
    {
        var owner = JazminKey.Generate();
        var gold = owner.CreateAccessKey();
        var file = Write(new JazminWriteOptions
        {
            Key = owner,
            ChunkRows = 50,
            Access = new JazminAccessOptions { PartitionBy = "Tier", Grants = [new JazminGrant(gold) { Rows = ["Gold"] }] },
        });
        var golds = People.Where(p => p.Tier == Tier.Gold).ToList();
        using var reader = JazminReader.Open(file, new JazminReadOptions { AccessKey = gold });
        var people = reader.AsQueryable<Person>();
        Assert.Equal(golds.Where(p => p.Id > 100).Skip(3).Take(5).Select(Describe), people.Where(p => p.Id > 100).Skip(3).Take(5).AsEnumerable().Select(Describe));
        Assert.Equal(golds.Count(p => p.Country == "ZA"), people.Count(p => p.Country == "ZA"));
        Assert.Equal(golds.Count(p => p.Id % 7 == 0), people.Count(p => p.Id % 7 == 0));
        Assert.True(people.Any(p => p.Id == 2));
        Assert.False(people.Any(p => p.Id == 3)); // Silver: not visible with this key
        Assert.Equal(golds.Select(p => new { p.Name, p.Balance }).Skip(10).Take(4), people.Select(p => new { p.Name, p.Balance }).Skip(10).Take(4));
    }

    public sealed class Pet
    {
        public string Name { get; set; } = "";

        public int? Age { get; set; } // a row that refers to an earlier one stores null here
    }

    [Fact]
    public void FilesThatPreserveReferences_AreQueriedInMemory_SoEveryReferenceResolves()
    {
        var (a, b) = (new Pet { Name = "a", Age = 1 }, new Pet { Name = "b", Age = 2 });
        var settings = new JazminSerializerSettings { PreserveReferencesHandling = PreserveReferencesHandling.Objects };
        using var reader = JazminReader.Open(JazminConvert.SerializeObject(new List<Pet> { a, b, a, b, a }, settings)); // rows 3-5 refer to rows 1-2
        var pets = reader.AsQueryable<Pet>(settings);
        Assert.Equal(["a", "b", "a"], pets.Skip(2).Select(p => p.Name));
        Assert.Equal(["a", "a", "a"], pets.Where(p => p.Name == "a").Select(p => p.Name));
        Assert.Equal(3, pets.Count(p => p.Age == 1));
        var last = pets.Skip(2).ToList();
        Assert.Same(last[0], last[2]);
    }

    // ---- the reader does the work -------------------------------------------------------------------

    /// <summary>Bytes a query reads after opening, one chunk at a time (no read-ahead), so counts compare exactly.</summary>
    private static long BytesRead(byte[] file, Action<JazminReader> query)
    {
        var stream = new CountingStream(new MemoryStream(file));
        using var reader = JazminReader.Open(stream, new JazminReadOptions { MaxDegreeOfParallelism = 1 });
        var opened = stream.BytesRead;
        query(reader);
        return stream.BytesRead - opened;
    }

    [Fact]
    public void ConditionsSkipTakeAndCounts_ReadWhatTheReaderReadsForThem()
    {
        var all = BytesRead(Unsorted, r => r.Rows().ToList());

        var lookup = BytesRead(Unsorted, r => r.AsQueryable<Person>().Where(p => p.Id == 42).ToList());
        Assert.Equal(BytesRead(Unsorted, r => r.Find(JazminFilter.Eq("Id", 42L)).ToList()), lookup);
        Assert.True(lookup < all / 2, $"{lookup} of {all} bytes"); // most of it the index, on a file this small

        var page = BytesRead(Unsorted, r => r.AsQueryable<Person>().Skip(400).Take(10).ToList());
        Assert.Equal(BytesRead(Unsorted, r => r.Find((JazminFilter?)null, new JazminQueryOptions { Offset = 400, Limit = 10 }).ToList()), page);
        Assert.True(page < all / 4, $"{page} of {all} bytes");

        Assert.Equal(BytesRead(Unsorted, r => r.Count(JazminFilter.Lt("Id", 100L))), BytesRead(Unsorted, r => r.AsQueryable<Person>().Count(p => p.Id < 100)));
        Assert.Equal(0, BytesRead(Unsorted, r => r.AsQueryable<Person>().LongCount())); // the header holds the row count
        Assert.Equal(BytesRead(Unsorted, r => r.Find(JazminFilter.Eq("Id", 300L)).First()), BytesRead(Unsorted, r => r.AsQueryable<Person>().First(p => p.Id == 300)));
    }

    [Fact]
    public void OrderingAlongTheSortOrder_ReadsNoMoreThanTheRowsItReturns()
    {
        var all = BytesRead(Sorted, r => r.Rows().ToList());
        var firstFive = BytesRead(Sorted, r => r.Find((JazminFilter?)null, new JazminQueryOptions { Limit = 5 }).ToList());
        Assert.True(firstFive < all / 4, $"{firstFive} of {all} bytes");
        Assert.Equal(firstFive, BytesRead(Sorted, r => r.AsQueryable<Person>().OrderBy(p => p.Id).Take(5).ToList()));
        Assert.Equal(firstFive, BytesRead(Sorted, r => r.AsQueryable<Person>().OrderBy(p => p.Id).ThenBy(p => p.Joined).Take(5).ToList()));
        Assert.Equal(all, BytesRead(Sorted, r => r.AsQueryable<Person>().OrderByDescending(p => p.Id).Take(5).ToList())); // sorted in memory
        Assert.Equal(all, BytesRead(Unsorted, r => r.AsQueryable<Person>().OrderBy(p => p.Id).Take(5).ToList())); // no sort order to use
    }

    [Fact]
    public void QueriesThatDoNotReturnObjects_ReadOnlyTheColumnsTheyUse()
    {
        var file = JazminConvert.SerializeObject(Enumerable.Range(0, 300).Select(i => new Probe { Id = i, Name = $"n{i}", Country = i % 2 == 0 ? "ZA" : "NA" }).ToList(),
            new JazminSerializerSettings { ChunkRows = 50 });
        using var reader = JazminReader.Open(file);
        var probes = reader.AsQueryable<Probe>();
        Probe.NamesSet = 0;

        Assert.Equal(Enumerable.Range(0, 300).Where(i => i % 3 == 0).Sum(), probes.Where(p => p.Id % 3 == 0).Sum(p => p.Id));
        Assert.Equal(150, probes.Select(p => new { p.Id, p.Country }).Count(x => x.Country == "ZA"));
        Assert.Equal([0, 2, 4], probes.Where(p => p.Country == "ZA").Select(p => p.Id).Take(3));
        Assert.Equal(299, probes.Max(p => p.Id));
        Assert.Equal(0, Probe.NamesSet);

        Assert.Equal(["n7", "n8"], probes.Skip(7).Take(2).Select(p => p.Name)); // Name used: read
        Assert.Equal(2, Probe.NamesSet);
        Assert.Equal(10, probes.Take(10).ToList().Count); // objects returned: every column read
        Assert.Equal(12, Probe.NamesSet);
    }
}
