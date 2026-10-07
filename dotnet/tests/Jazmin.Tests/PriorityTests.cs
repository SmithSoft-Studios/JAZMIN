using Jazmin.Query;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// <see cref="JazminPriority"/>: memory or speed first. It only sets defaults (threads, decoded columns in flight), so
/// every priority must write the same data and read the same rows.
/// </summary>
public sealed class PriorityTests
{
    private static readonly int Cores = Environment.ProcessorCount;

    [Fact]
    public void Priority_SetsTheDefaultThreads_AndAnExplicitCountWins()
    {
        Assert.Equal(Math.Min(Cores, 4), new JazminReadOptions().MaxDegreeOfParallelism);
        Assert.Equal(1, new JazminReadOptions { Priority = JazminPriority.Memory }.MaxDegreeOfParallelism);
        Assert.Equal(Math.Min(Cores, 8), new JazminReadOptions { Priority = JazminPriority.Speed }.MaxDegreeOfParallelism);
        Assert.Equal(3, new JazminReadOptions { MaxDegreeOfParallelism = 3, Priority = JazminPriority.Memory }.MaxDegreeOfParallelism);
        Assert.Equal(3, new JazminReadOptions { Priority = JazminPriority.Speed, MaxDegreeOfParallelism = 3 }.MaxDegreeOfParallelism);

        Assert.Equal(Math.Min(Cores, 16), new JazminWriteOptions().MaxDegreeOfParallelism);
        Assert.Equal(1, new JazminWriteOptions { Priority = JazminPriority.Memory }.MaxDegreeOfParallelism);
        Assert.Equal(Math.Min(Cores, 16), new JazminWriteOptions { Priority = JazminPriority.Speed }.MaxDegreeOfParallelism);
        Assert.Equal(5, new JazminWriteOptions { MaxDegreeOfParallelism = 5, Priority = JazminPriority.Memory }.MaxDegreeOfParallelism);

        var settings = new JazminSerializerSettings { Priority = JazminPriority.Memory };
        Assert.Equal(JazminPriority.Memory, settings.ToReadOptions().Priority);
        Assert.Equal(1, settings.ToWriteOptions().MaxDegreeOfParallelism);
    }

    [Fact]
    public void EveryPriority_WritesTheSameData_AndReadsTheSameRows()
    {
        // 200 columns: Balanced keeps a full read on one chunk at a time (128 decoded columns in flight), Speed decodes
        // chunks ahead (1,024 columns), Memory does everything on the calling thread.
        var columns = Enumerable.Range(0, 200).Select(c => new JazminColumn($"c{c}", (c % 3) switch
        {
            0 => JazminType.Int,
            1 => JazminType.String,
            _ => JazminType.Float,
        }) { Nullable = true }).ToArray();
        var key = JazminKey.Generate();
        byte[] Write(JazminPriority priority)
        {
            var stream = new MemoryStream();
            using (var writer = new JazminWriter(stream, columns, new JazminWriteOptions { ChunkRows = 64, Key = key, Priority = priority }, leaveOpen: true))
            {
                var values = new object?[columns.Length];
                for (var r = 0; r < 1000; r++)
                {
                    for (var c = 0; c < values.Length; c++)
                        values[c] = (r + c) % 11 == 0 ? null : (c % 3) switch { 0 => (object)(long)(r * c), 1 => $"v{r % 37}-{c}", _ => r / (c + 1.0) };
                    writer.WriteValues(values);
                }
            }
            return stream.ToArray();
        }
        string Dump(byte[] file, JazminPriority priority, JazminFilter? filter = null, JazminQueryOptions? options = null)
        {
            using var reader = JazminReader.Open(file, new JazminReadOptions { Key = key, Priority = priority });
            return string.Join("\n", reader.Find(filter, options).Select(r => string.Join("|", r.Select(p => $"{p.Key}={p.Value}")))) + $"#{reader.ChunkCount}";
        }

        var priorities = Enum.GetValues<JazminPriority>();
        var expected = Dump(Write(JazminPriority.Balanced), JazminPriority.Balanced);
        foreach (var writePriority in priorities)
        {
            var file = Write(writePriority);
            foreach (var readPriority in priorities)
            {
                Assert.Equal(expected, Dump(file, readPriority));
                Assert.Equal(Dump(file, JazminPriority.Balanced, null, new() { Select = ["c0", "c1"] }), Dump(file, readPriority, null, new() { Select = ["c0", "c1"] }));
                Assert.Equal(Dump(file, JazminPriority.Balanced, JazminFilter.Gt("c3", 5000L), new() { Limit = 7 }),
                    Dump(file, readPriority, JazminFilter.Gt("c3", 5000L), new() { Limit = 7 })); // stops early while chunks are in flight
            }
        }
    }
}
