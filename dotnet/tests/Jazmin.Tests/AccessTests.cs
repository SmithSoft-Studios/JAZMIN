using System.Text;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

public class AccessTests
{
    private static readonly JazminKey Owner = JazminKey.Generate();
    private static readonly JazminAccessKey Bob = Owner.CreateAccessKey();
    private static readonly JazminAccessKey Sally = Owner.CreateAccessKey();
    private static readonly JazminAccessKey Carol = Owner.CreateAccessKey(); // issued, never granted

    private static readonly JazminColumn[] Columns =
    {
        new("id", JazminType.Int) { Nullable = false, Indexes = [JazminIndexKind.Sorted] },
        new("country", JazminType.String) { Indexes = [JazminIndexKind.Sorted] },
        new("name", JazminType.String),
        new("salary", JazminType.Float),
        new("idNumber", JazminType.String),
    };

    private static readonly string?[] Countries = { "ZA", "NA", "BW", null };

    // Deliberately interleaved: every row starts a new chunk, the worst case for partitioning.
    private static readonly object?[][] Rows = Enumerable.Range(0, 40)
        .Select(i => new object?[] { (long)i, Countries[i % 4], $"Person {i}", 1000.0 + i, $"ID-{i}" }).ToArray();

    private static JazminAccessOptions Access() => new()
    {
        PartitionBy = "country",
        ColumnGroups = new() { ["pii"] = ["salary", "idNumber"] },
        Grants =
        [
            new JazminGrant(Bob) { Rows = ["ZA"], Columns = ["*"], Label = "Bob" },
            new JazminGrant(JazminAccessKey.Parse(Sally.ToString())) { Rows = ["BW", "NA"], Label = "Sally" },
        ],
    };

    private static readonly byte[] File = TestData.Write(Columns, Rows, new JazminWriteOptions { Key = Owner, Access = Access() });

    private static long[] Ids(IEnumerable<JazminRow> rows) => rows.Select(r => (long)r["id"]!).ToArray();

    [Fact]
    public void Owner_SeesEverything_WithIndexesAndGrants()
    {
        using var r = JazminReader.Open(File, new JazminReadOptions { Key = Owner });
        Assert.Equal(40, r.RowCount);
        Assert.Equal(5, r.Columns.Count);
        Assert.True(r.Access!.IsOwner);
        Assert.Equal(new[] { ("Bob", Bob.Id), ("Sally", Sally.Id) }, r.Access.Grants!.Select(g => (g.Label!, g.KeyId)));
        Assert.Null(r.Access.Grants![1].Columns); // "*"
        Assert.Equal(["id", "country", "name"], r.Access.GroupColumns!["*"]);
        Assert.Equal(["salary", "idNumber"], r.Access.GroupColumns["pii"]);
        Assert.Equal("index", r.Explain(JazminFilter.Eq("id", 7)).Strategy);
    }

    [Fact]
    public void Bob_SeesOnlyHisRows_WithoutRestrictedColumns()
    {
        using var r = JazminReader.Open(File, new JazminReadOptions { AccessKey = JazminAccessKey.Parse(Bob.ToString()) });
        Assert.Equal(new[] { "id", "country", "name" }, r.Columns.Select(c => c.Name));
        Assert.Equal(Rows.Where(x => (string?)x[1] == "ZA").Select(x => (long)x[0]!), Ids(r.Rows()));
        Assert.Equal(10, r.RowCount);
        Assert.Equal(30, r.HiddenRowCount);
        Assert.Equal(new[] { "ZA" }, r.Access!.VisiblePartitions);
        Assert.Null(r.Access.Grants);
        Assert.Null(r.Access.GroupColumns);
        Assert.Empty(r.Indexes);
        Assert.Equal(new[] { 12L }, Ids(r.Find(JazminFilter.Contains("name", "12"))));
        Assert.Throws<JazminValidationException>(() => r.Find(JazminFilter.Gt("salary", 0.0)));
        Assert.Throws<JazminKeyException>(() => r.Get(1));
        Assert.Equal("Person 0", r.Get(0)["name"]);
        Assert.False(r.Get(0).ContainsKey("salary"));
    }

    [Fact]
    public void Sally_SeesHerGroups_IncludingRestrictedColumns()
    {
        using var r = JazminReader.Open(File, new JazminReadOptions { AccessKey = Sally });
        Assert.Equal(Rows.Where(x => (string?)x[1] is "BW" or "NA").Select(x => (long)x[0]!), Ids(r.Rows()));
        Assert.Equal(new[] { 33L, 37L }, Ids(r.Find(JazminFilter.Eq("country", "NA") & JazminFilter.Gt("salary", 1030.0))));
        Assert.Equal(10, r.Explain(JazminFilter.Eq("country", "NA")).ChunksSkipped);
    }

    [Fact]
    public void UngrantedAndForeignKeys_AreRejected()
    {
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(File, new JazminReadOptions { AccessKey = Carol }));
        var stranger = JazminKey.Generate();
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(File, new JazminReadOptions { AccessKey = stranger.CreateAccessKey() }));
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(File, new JazminReadOptions { Key = stranger }));
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(File));
        Assert.Throws<JazminKeyException>(() => JazminReader.Open(File, new JazminReadOptions { Password = "x" }));
    }

    [Fact]
    public void ContentIsEncrypted_AndTamperingIsDetected()
    {
        var text = Encoding.UTF8.GetString(File);
        Assert.DoesNotContain("Person 1", text);
        Assert.DoesNotContain("salary", text);

        var damaged = (byte[])File.Clone();
        damaged[100] ^= 1;
        using (var r = JazminReader.Open(damaged, new JazminReadOptions { Key = Owner }))
            Assert.Throws<JazminFormatException>(() => r.Rows().ToList());
    }

    [Fact]
    public void OnlyTheOwnerKeyCanCreate_AndGrantsMustComeFromThatOwner()
    {
        Assert.Throws<JazminValidationException>(() => TestData.Write(Columns, Rows, new JazminWriteOptions { Access = Access() }));
        var foreign = JazminKey.Generate().CreateAccessKey();
        Assert.Throws<JazminValidationException>(() => TestData.Write(Columns, Rows,
            new JazminWriteOptions { Key = Owner, Access = new JazminAccessOptions { Grants = [new JazminGrant(foreign)] } }));
    }

    [Fact]
    public void OwnerSigningKey_IsDeterministicAndOnTheCurve()
    {
        var key = JazminKey.Parse(Owner.ToString());
        Assert.Equal(Owner.OwnerPublicKey, key.OwnerPublicKey);
        // The derived point must be accepted by the platform's ECDSA implementation.
        var point = key.OwnerPublicKey;
        using var ecdsa = System.Security.Cryptography.ECDsa.Create(new System.Security.Cryptography.ECParameters
        {
            Curve = System.Security.Cryptography.ECCurve.NamedCurves.nistP256,
            Q = new System.Security.Cryptography.ECPoint { X = point[1..33], Y = point[33..] },
        });
        Assert.Equal(256, ecdsa.KeySize);
    }
}
