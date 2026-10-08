using System.Text.Json;
using Jazmin.Query;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// The parts of a LINQ query that run in memory are compiled once per query shape and reused with each call's values:
/// the same query with other captured values, other constants or other sub-queries gives what LINQ to Objects gives,
/// every time. Queries of another shape (another member, another type, another operator) compile their own code.
/// </summary>
[Collection("Compiled queries")] // the compile counter is shared: these tests do not run beside each other
public sealed class QueryPlanCacheTests
{
    public sealed class Person
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public string Region { get; set; } = "";
        public decimal Balance { get; set; }
        public List<int> Scores { get; set; } = [];
    }

    private static readonly List<Person> People = Enumerable.Range(0, 300).Select(i => new Person
    {
        Id = i, Name = $"P{i}", Region = new[] { "ZA", "NA", "BW" }[i % 3], Balance = i * 1.5m, Scores = [i % 7, i % 5],
    }).ToList();

    private static readonly byte[] File = JazminConvert.SerializeObject(People, new JazminSerializerSettings { ChunkRows = 32 });

    private static void Same<T>(Func<IQueryable<Person>, T> query, IQueryable<Person> file) =>
        Assert.Equal(JsonSerializer.Serialize(query(People.AsQueryable())), JsonSerializer.Serialize(query(file)));

    [Fact]
    public void TheSameQueryWithOtherValues_GivesEachCallsAnswer_AndCompilesOnce()
    {
        using var reader = JazminReader.Open(File);
        var q = reader.AsQueryable<Person>();
        q.Where(p => p.Id == -1).Select(p => p.Name).ToList(); // the shape compiled
        var before = CompiledQueries.Compilations;
        for (var id = 0; id < 300; id += 7)
        {
            var name = q.Where(p => p.Id == id).Select(p => p.Name).ToList(); // a captured variable, a new value each time
            Assert.Equal([$"P{id}"], name);
            var region = new[] { "ZA", "NA", "BW" }[id % 3];
            Same(s => s.Where(p => p.Region == region).Select(p => new { p.Id, Twice = p.Balance * 2 }).Skip(id % 5).Take(3).ToList(), q);
            Same(s => s.Select(p => p.Scores.Count(x => x > id % 7)).Sum(), q); // a value inside the in-memory part
        }
        Assert.True(CompiledQueries.Compilations - before <= 3, $"{CompiledQueries.Compilations - before} compilations for 3 shapes");
    }

    [Fact]
    public void QueriesOfAnotherShape_GetTheirOwnCode()
    {
        using var reader = JazminReader.Open(File);
        var q = reader.AsQueryable<Person>();
        // The same structure, another member; another operator; constants of the same type with other values.
        Same(s => s.Where(p => p.Id < 20).Select(p => p.Name).ToList(), q);
        Same(s => s.Where(p => p.Id < 20).Select(p => p.Region).ToList(), q);
        Same(s => s.Where(p => p.Id < 20).Select(p => p.Region).Distinct().ToList(), q);
        Same(s => s.Where(p => p.Id < 20).Select(p => p.Balance > 10m ? "high" : "low").ToList(), q);
        Same(s => s.Where(p => p.Id < 20).Select(p => p.Balance > 20m ? "rich" : "poor").ToList(), q);
        // Parts of a predicate the reader cannot check, run in memory with each call's values.
        foreach (var n in new[] { 3, 4 }) Same(s => s.Where(p => p.Name.Length == n && p.Scores.Contains(n)).Select(p => p.Id).ToList(), q);
        foreach (var n in new[] { 3, 4 }) Assert.Equal(People.Where(p => p.Name.Length == n).Select(p => p.Id), reader.Query<Person>(p => p.Name.Length == n).Select(p => p.Id));
        // Results that are not sequences, and operators that end a query.
        Same(s => s.Where(p => p.Region == "BW").OrderByDescending(p => p.Balance).First().Name, q);
        Same(s => s.GroupBy(p => p.Region).Select(g => new { g.Key, Total = g.Sum(p => p.Balance) }).OrderBy(x => x.Key).ToList(), q);
    }
}

[CollectionDefinition("Compiled queries", DisableParallelization = true)]
public sealed class CompiledQueriesCollection;
