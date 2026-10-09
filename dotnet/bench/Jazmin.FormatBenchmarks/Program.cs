// JAZMIN beside other formats, for reference (USER-GUIDE 9.12): Parquet (Parquet.Net), Arrow IPC (Apache.Arrow),
// SQLite (Microsoft.Data.Sqlite) and MessagePack (MessagePack-CSharp), on the same 200,000 customers as
// Jazmin.Benchmarks. Each format is used as its library documents it, with its defaults; the notes printed at the end
// say what that means. Every figure is the best of 3 runs after 3 warm-up runs, for every contender alike.
//   dotnet run -c Release --project bench/Jazmin.FormatBenchmarks [rows]
using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using Apache.Arrow;
using Apache.Arrow.Ipc;
using Apache.Arrow.Types;
using Jazmin;
using Jazmin.Serialization;
using MessagePack;
using Microsoft.Data.Sqlite;
using Parquet;
using Parquet.Serialization;

var rowsCount = args.Length > 0 ? int.Parse(args[0]) : 200_000;
var countries = new[] { "ZA", "NA", "BW", "ZW", "MZ", "LS", "SZ", "ZM" };
var first = new[] { "Ann", "Bob", "Thabo", "Lerato", "Pieter", "Aisha", "Sipho", "Maria" };
var last = new[] { "Smith", "Johnson", "Ndlovu", "Botha", "Naidoo", "Mokoena", "van Wyk", "Dlamini" };
var people = Enumerable.Range(0, rowsCount).Select(i => new Customer
{
    Id = i,
    Name = $"{first[i % 8]} {last[i * 7 % 8]}",
    Email = $"user{i}@example.com",
    Country = countries[i * 13 % 8],
    Age = 18 + i * 31 % 70,
    Balance = Math.Round(i * 7919 % 1_000_000 * 1.37) / 100,
    Joined = new DateTime(2015, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays(i % 3650),
    Active = i % 3 != 0,
}).ToList();
var target = (int)(rowsCount * 0.6173);
var expectedFilter = people.Count(c => c.Country == "NA" && c.Age > 80);
var expectedContains = people.Count(c => c.Name.Contains("Ndlovu"));
var expectedSum = people.Sum(c => c.Balance);

var dir = Directory.CreateTempSubdirectory("jazmin-formats-").FullName;
string F(string name) => Path.Combine(dir, name);

static double Time(Func<object?> action, Action<object?> check, int repeat = 3)
{
    for (var i = 0; i < 3; i++) check(action());
    var best = double.MaxValue;
    for (var i = 0; i < repeat; i++)
    {
        GC.Collect();
        GC.WaitForPendingFinalizers();
        var sw = Stopwatch.StartNew();
        action();
        best = Math.Min(best, sw.Elapsed.TotalMilliseconds);
    }
    return best;
}

void Check(string what, object? got, object want)
{
    var ok = want is double d ? got is double g && Math.Abs(g - d) < 1e-6 * Math.Abs(d) : Equals(Convert.ChangeType(got, want.GetType()), want);
    if (!ok) throw new InvalidOperationException($"{what}: got {got}, expected {want}");
}

var indexed = new JazminSerializerSettings
{
    Indexes = new Dictionary<string, JazminIndexKind[]>
    {
        ["Id"] = [JazminIndexKind.Sorted],
        ["Country"] = [JazminIndexKind.Sorted],
        ["Name"] = [JazminIndexKind.Trigram],
    },
};

// ---- Arrow: the rows as one record batch, and back --------------------------------------------------------------------

RecordBatch ArrowBatch() => new RecordBatch.Builder()
    .Append("Id", false, c => c.Int32(a => a.AppendRange(people.Select(p => p.Id))))
    .Append("Name", false, c => c.String(a => a.AppendRange(people.Select(p => p.Name))))
    .Append("Email", false, c => c.String(a => a.AppendRange(people.Select(p => p.Email))))
    .Append("Country", false, c => c.String(a => a.AppendRange(people.Select(p => p.Country))))
    .Append("Age", false, c => c.Int32(a => a.AppendRange(people.Select(p => p.Age))))
    .Append("Balance", false, c => c.Double(a => a.AppendRange(people.Select(p => p.Balance))))
    .Append("Joined", false, c => c.Timestamp(a => a.AppendRange(people.Select(p => new DateTimeOffset(p.Joined)))))
    .Append("Active", false, c => c.Boolean(a => a.AppendRange(people.Select(p => p.Active))))
    .Build();

RecordBatch ReadArrow()
{
    using var stream = File.OpenRead(F("data.arrow"));
    using var reader = new ArrowFileReader(stream);
    return reader.ReadNextRecordBatch();
}

Customer ArrowRow(RecordBatch b, int i) => new()
{
    Id = ((Int32Array)b.Column("Id")).GetValue(i)!.Value,
    Name = ((StringArray)b.Column("Name")).GetString(i),
    Email = ((StringArray)b.Column("Email")).GetString(i),
    Country = ((StringArray)b.Column("Country")).GetString(i),
    Age = ((Int32Array)b.Column("Age")).GetValue(i)!.Value,
    Balance = ((DoubleArray)b.Column("Balance")).GetValue(i)!.Value,
    Joined = ((TimestampArray)b.Column("Joined")).GetTimestamp(i)!.Value.UtcDateTime,
    Active = ((BooleanArray)b.Column("Active")).GetValue(i)!.Value,
};

// ---- Parquet: columns read on their own, row group by row group, as a columnar reader does --------------------------

(T[] Values, long Rows) ParquetColumn<T>(string name) where T : struct
{
    var reader = ParquetReader.CreateAsync(F("data.parquet")).GetAwaiter().GetResult();
    using var close = new Closing(reader); // the reader is IAsyncDisposable only
    var field = reader.Schema.DataFields.First(f => f.Name == name);
    var values = new List<T>();
    for (var g = 0; g < reader.RowGroupCount; g++)
    {
        using var rg = reader.OpenRowGroupReader(g);
        var part = new T[rg.RowCount];
        rg.ReadAsync<T>(field, part).GetAwaiter().GetResult();
        values.AddRange(part);
    }
    return (values.ToArray(), values.Count);
}

string[] ParquetStrings(string name)
{
    var reader = ParquetReader.CreateAsync(F("data.parquet")).GetAwaiter().GetResult();
    using var close = new Closing(reader); // the reader is IAsyncDisposable only
    var field = reader.Schema.DataFields.First(f => f.Name == name);
    var values = new List<string>();
    for (var g = 0; g < reader.RowGroupCount; g++)
    {
        using var rg = reader.OpenRowGroupReader(g);
        var part = new string[rg.RowCount];
        rg.ReadAsync(field, part).GetAwaiter().GetResult();
        values.AddRange(part);
    }
    return values.ToArray();
}

// ---- SQLite: the same indexes as JAZMIN's file (id, country); each query opens the file, as JAZMIN's do --------------

var sqlite = $"Data Source={F("data.sqlite")};Mode=ReadOnly;Pooling=False";
T Sqlite<T>(Func<SqliteConnection, T> query)
{
    using var connection = new SqliteConnection(sqlite);
    connection.Open();
    return query(connection);
}

Customer SqliteRow(SqliteDataReader r) => new()
{
    Id = r.GetInt32(0), Name = r.GetString(1), Email = r.GetString(2), Country = r.GetString(3), Age = r.GetInt32(4),
    Balance = r.GetDouble(5), Joined = DateTime.UnixEpoch.AddMilliseconds(r.GetInt64(6)), Active = r.GetInt64(7) != 0,
};

long Scalar(SqliteConnection c, string sql)
{
    using var command = c.CreateCommand();
    command.CommandText = sql;
    return Convert.ToInt64(command.ExecuteScalar());
}

// ---- the contenders --------------------------------------------------------------------------------------------------

var contenders = new List<Contender>
{
    new("JAZMIN",
        Write: () => File.WriteAllBytes(F("data.jzm"), JazminConvert.SerializeObject(people, indexed)),
        File: "data.jzm",
        ReadAll: () => JazminConvert.DeserializeObject<List<Customer>>(File.ReadAllBytes(F("data.jzm")))!.Count,
        Sum: () => { using var r = JazminReader.Open(F("data.jzm")); return r.AsQueryable<Customer>().Sum(c => c.Balance); },
        Lookup: () => { using var r = JazminReader.Open(F("data.jzm")); return r.Query<Customer>(c => c.Id == target).First().Id; },
        Filter: () => { using var r = JazminReader.Open(F("data.jzm")); return r.Query<Customer>(c => c.Country == "NA" && c.Age > 80).Count(); },
        Contains: () => { using var r = JazminReader.Open(F("data.jzm")); return r.Query<Customer>(c => c.Name.Contains("Ndlovu")).Count(); }),

    new("Parquet",
        Write: () => { using var s = File.Create(F("data.parquet")); ParquetSerializer.SerializeAsync(people, s).GetAwaiter().GetResult(); },
        File: "data.parquet",
        ReadAll: () => { using var s = File.OpenRead(F("data.parquet")); return ParquetSerializer.DeserializeAsync<Customer>(s).GetAwaiter().GetResult().Data.Count; },
        Sum: () => ParquetColumn<double>("Balance").Values.Sum(),
        Lookup: () =>
        {
            // The id column first; then the row: each column's value at that position (no index to go by).
            var i = System.Array.IndexOf(ParquetColumn<int>("Id").Values, target);
            return new Customer
            {
                Id = ParquetColumn<int>("Id").Values[i], Name = ParquetStrings("Name")[i], Email = ParquetStrings("Email")[i], Country = ParquetStrings("Country")[i],
                Age = ParquetColumn<int>("Age").Values[i], Balance = ParquetColumn<double>("Balance").Values[i],
                Joined = ParquetColumn<DateTime>("Joined").Values[i], Active = ParquetColumn<bool>("Active").Values[i],
            }.Id;
        },
        Filter: () =>
        {
            var country = ParquetStrings("Country");
            var age = ParquetColumn<int>("Age").Values;
            var n = 0;
            for (var i = 0; i < age.Length; i++) if (age[i] > 80 && country[i] == "NA") n++;
            return n;
        },
        Contains: () => ParquetStrings("Name").Count(n => n.Contains("Ndlovu"))),

    new("Arrow IPC",
        Write: () =>
        {
            var batch = ArrowBatch();
            using var s = File.Create(F("data.arrow"));
            using var writer = new ArrowFileWriter(s, batch.Schema);
            writer.WriteRecordBatch(batch);
            writer.WriteEnd();
        },
        File: "data.arrow",
        ReadAll: () => { var b = ReadArrow(); var list = new List<Customer>(b.Length); for (var i = 0; i < b.Length; i++) list.Add(ArrowRow(b, i)); return list.Count; },
        Sum: () => { var b = ReadArrow(); var balance = (DoubleArray)b.Column("Balance"); var s = 0.0; for (var i = 0; i < b.Length; i++) s += balance.GetValue(i)!.Value; return s; },
        Lookup: () => { var b = ReadArrow(); var ids = ((Int32Array)b.Column("Id")).Values; return ArrowRow(b, ids.IndexOf(target)).Id; },
        Filter: () =>
        {
            var b = ReadArrow();
            var country = (StringArray)b.Column("Country");
            var age = ((Int32Array)b.Column("Age")).Values;
            var n = 0;
            for (var i = 0; i < age.Length; i++) if (age[i] > 80 && country.GetString(i) == "NA") n++;
            return n;
        },
        Contains: () => { var b = ReadArrow(); var name = (StringArray)b.Column("Name"); var n = 0; for (var i = 0; i < b.Length; i++) if (name.GetString(i).Contains("Ndlovu")) n++; return n; }),

    new("SQLite",
        Write: () =>
        {
            File.Delete(F("data.sqlite"));
            using var c = new SqliteConnection($"Data Source={F("data.sqlite")};Pooling=False");
            c.Open();
            using (var create = c.CreateCommand())
            {
                create.CommandText = "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, country TEXT, age INTEGER, balance REAL, joined INTEGER, active INTEGER); CREATE INDEX customers_country ON customers (country)";
                create.ExecuteNonQuery();
            }
            using var tx = c.BeginTransaction();
            using var insert = c.CreateCommand();
            insert.CommandText = "INSERT INTO customers VALUES ($id, $name, $email, $country, $age, $balance, $joined, $active)";
            var ps = new[] { "$id", "$name", "$email", "$country", "$age", "$balance", "$joined", "$active" }.Select(n => insert.Parameters.Add(n, SqliteType.Text)).ToArray();
            foreach (var p in people)
            {
                ps[0].Value = p.Id; ps[1].Value = p.Name; ps[2].Value = p.Email; ps[3].Value = p.Country; ps[4].Value = p.Age;
                ps[5].Value = p.Balance; ps[6].Value = (long)(p.Joined - DateTime.UnixEpoch).TotalMilliseconds; ps[7].Value = p.Active ? 1 : 0;
                insert.ExecuteNonQuery();
            }
            tx.Commit();
        },
        File: "data.sqlite",
        ReadAll: () => Sqlite(c =>
        {
            using var command = c.CreateCommand();
            command.CommandText = "SELECT * FROM customers";
            using var r = command.ExecuteReader();
            var list = new List<Customer>();
            while (r.Read()) list.Add(SqliteRow(r));
            return list.Count;
        }),
        Sum: () => Sqlite(c => { using var command = c.CreateCommand(); command.CommandText = "SELECT sum(balance) FROM customers"; return Convert.ToDouble(command.ExecuteScalar()); }),
        Lookup: () => Sqlite(c =>
        {
            using var command = c.CreateCommand();
            command.CommandText = "SELECT * FROM customers WHERE id = $id";
            command.Parameters.AddWithValue("$id", target);
            using var r = command.ExecuteReader();
            r.Read();
            return SqliteRow(r).Id;
        }),
        Filter: () => Sqlite(c => Scalar(c, "SELECT count(*) FROM customers WHERE country = 'NA' AND age > 80")),
        Contains: () => Sqlite(c => Scalar(c, "SELECT count(*) FROM customers WHERE name LIKE '%Ndlovu%'"))),

    new("MessagePack",
        Write: () => File.WriteAllBytes(F("data.msgpack"), MessagePackSerializer.Serialize(people)),
        File: "data.msgpack",
        ReadAll: () => MessagePackSerializer.Deserialize<List<Customer>>(File.ReadAllBytes(F("data.msgpack"))).Count,
        Sum: () => MessagePackSerializer.Deserialize<List<Customer>>(File.ReadAllBytes(F("data.msgpack"))).Sum(c => c.Balance),
        Lookup: () => MessagePackSerializer.Deserialize<List<Customer>>(File.ReadAllBytes(F("data.msgpack"))).First(c => c.Id == target).Id,
        Filter: () => MessagePackSerializer.Deserialize<List<Customer>>(File.ReadAllBytes(F("data.msgpack"))).Count(c => c.Country == "NA" && c.Age > 80),
        Contains: () => MessagePackSerializer.Deserialize<List<Customer>>(File.ReadAllBytes(F("data.msgpack"))).Count(c => c.Name.Contains("Ndlovu"))),
};

// ---- run ------------------------------------------------------------------------------------------------------------

var results = new Dictionary<string, Dictionary<string, string>>();
foreach (var c in contenders)
{
    var r = results[c.Name] = new();
    r["write"] = $"{Time(() => { c.Write(); return null; }, _ => { }):N0} ms";
    r["size"] = $"{new FileInfo(F(c.File)).Length / 1024:N0} KB";
    r["readAll"] = $"{Time(() => c.ReadAll(), v => Check($"{c.Name} read", v, rowsCount)):N0} ms";
    r["sum"] = $"{Time(() => c.Sum(), v => Check($"{c.Name} sum", v, expectedSum)):N1} ms";
    r["lookup"] = $"{Time(() => c.Lookup(), v => Check($"{c.Name} lookup", v, target)):N1} ms";
    r["filter"] = $"{Time(() => c.Filter(), v => Check($"{c.Name} filter", v, expectedFilter)):N1} ms";
    r["contains"] = $"{Time(() => c.Contains(), v => Check($"{c.Name} contains", v, expectedContains)):N1} ms";
}

Console.WriteLine($"\nJAZMIN beside other formats - {RuntimeInformation.FrameworkDescription}, {RuntimeInformation.OSDescription}, {rowsCount:N0} rows\n");
var measures = new (string Key, string Label)[]
{
    ("size", "File size"), ("write", "Write every row"), ("readAll", "Read every row (objects)"), ("sum", "Sum one column"),
    ("lookup", "Find one row by id (open → row)"), ("filter", "Filter: country = NA, age > 80"), ("contains", "Text search: name contains 'Ndlovu'"),
};
Console.WriteLine("Measure".PadRight(38) + string.Concat(contenders.Select(c => c.Name.PadLeft(13))));
foreach (var (key, label) in measures)
    Console.WriteLine(label.PadRight(38) + string.Concat(contenders.Select(c => results[c.Name][key].PadLeft(13))));
var gz = new MemoryStream();
using (var z = new GZipStream(gz, CompressionLevel.Optimal, leaveOpen: true)) z.Write(File.ReadAllBytes(F("data.msgpack")));
Console.WriteLine($"""

Notes:
- JAZMIN: deflate, 3 indexes (Id sorted, Name trigram, Country sorted); LINQ queries read only the columns they use.
- Parquet: Parquet.Net's ParquetSerializer with its defaults (one row group, Snappy) to write and read every row;
  the queries read only the columns they need, without an index (for "Find one row", the id column, then the row).
- Arrow IPC: the file format, uncompressed (Apache.Arrow's defaults); read whole, then searched.
- SQLite: Microsoft.Data.Sqlite without connection pooling (each query opens the file, as JAZMIN's do); id is the
  primary key, with an index on country; LIKE scans for the text search.
- MessagePack: MessagePack-CSharp with [Key] attributes (arrays, its fastest form); every query reads the whole file
  (gzipped it would be {gz.Length / 1024:N0} KB).
""");
Directory.Delete(dir, true);

/// <summary>Disposes an IAsyncDisposable at the end of a using block.</summary>
internal sealed class Closing(IAsyncDisposable target) : IDisposable
{
    public void Dispose() => target.DisposeAsync().AsTask().GetAwaiter().GetResult();
}

/// <summary>One format: how it writes the rows, which file it makes, and how it answers each query.</summary>
internal sealed record Contender(string Name, Action Write, string File, Func<object?> ReadAll, Func<object?> Sum, Func<object?> Lookup, Func<object?> Filter, Func<object?> Contains);

[MessagePackObject]
public sealed class Customer
{
    [Key(0)] public int Id { get; set; }
    [Key(1)] public string Name { get; set; } = "";
    [Key(2)] public string Email { get; set; } = "";
    [Key(3)] public string Country { get; set; } = "";
    [Key(4)] public int Age { get; set; }
    [Key(5)] public double Balance { get; set; }
    [Key(6)] public DateTime Joined { get; set; }
    [Key(7)] public bool Active { get; set; }
}
