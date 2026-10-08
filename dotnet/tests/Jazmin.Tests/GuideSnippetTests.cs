using System.ComponentModel;
using System.Text.Json.Nodes;
using Jazmin.Query;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>Keeps the code in docs/USER-GUIDE.md section 6 compiling and working.</summary>
public class GuideSnippetTests
{
    public enum GuideTier { Bronze, Silver, Gold }

    public class GuideCustomer
    {
        [JazminIndex]
        public int Id { get; set; }

        [JazminIndex(JazminIndexKind.Sorted, JazminIndexKind.Trigram)]
        [Description("Full name")]
        public string Name { get; set; } = "";

        [JazminProperty("country_code", Description = "ISO 3166 alpha-2")]
        public string? Country { get; set; }

        public GuideTier Tier { get; set; }
        public decimal Balance { get; set; }
        public DateTime Joined { get; set; }
        public List<string> Tags { get; set; } = new();

        [JazminIgnore]
        public string? PasswordHash { get; set; }
    }

    [Fact]
    public void Section6_Snippets()
    {
        var path = Path.Combine(Path.GetTempPath(), $"guide-{Guid.NewGuid():N}.jzm");
        var key = JazminKey.Generate();
        var customers = Enumerable.Range(0, 20).Select(i => new GuideCustomer
        {
            Id = i,
            Name = i == 7 ? "Thabo Ndlovu" : $"Customer {i}",
            Country = i % 2 == 0 ? "ZA" : "NA",
            Tier = (GuideTier)(i % 3),
            Balance = 50m * i,
            Joined = DateTime.UnixEpoch.AddDays(i),
        }).ToList();
        try
        {
            // 6.3
            var settings = new JazminSerializerSettings
            {
                Key = key,
                Codec = JazminCodec.Brotli,
                ChunkRows = 4096,
                Metadata = new JsonObject { ["source"] = "crm" },
                Indexes = new() { ["Tier"] = new[] { JazminIndexKind.Sorted } },
                Formatting = Formatting.Indented,
                NullValueHandling = NullValueHandling.Ignore,
            };
            new JazminSerializer(settings).Serialize(path, customers);

            // 6.4
            using (var reader = JazminReader.Open(path, new JazminReadOptions { Key = key }))
            {
                Assert.Equal(customers.Where(c => c.Country == "ZA" && c.Balance > 100m).Select(c => c.Id),
                    reader.Query<GuideCustomer>(c => c.Country == "ZA" && c.Balance > 100m).Select(c => c.Id));
                var top = reader.Query<GuideCustomer>(c => c.Tier == GuideTier.Gold).OrderByDescending(c => c.Balance).Take(10).ToList();
                Assert.Equal(17, top[0].Id); // Gold = i % 3 == 2
                var queryable = reader.AsQueryable<GuideCustomer>();
                Assert.Equal(customers.Where(c => c.Country == "ZA").Skip(2).Take(3).Select(c => c.Id),
                    queryable.Where(c => c.Country == "ZA").Skip(2).Take(3).ToList().Select(c => c.Id));
                Assert.Equal(customers.Count(c => c.Tier == GuideTier.Gold), queryable.Count(c => c.Tier == GuideTier.Gold));
                Assert.Equal(customers.Where(c => c.Balance > 100m).Select(c => new { c.Id, c.Name }),
                    queryable.Where(c => c.Balance > 100m).Select(c => new { c.Id, c.Name }).ToList());
                Assert.Single(reader.Find(JazminFilter.Eq("country_code", "NA") & JazminFilter.IContains("Name", "ndlovu")));
                Assert.Single(reader.Find("""{ "Name": { "icontains": "ndlovu" } }"""));
                Assert.Equal(10, reader.Count(JazminFilter.Eq("country_code", "ZA")));
                Assert.Equal("index", reader.Explain(JazminFilter.Eq("Id", 3)).Strategy);
                Assert.Equal(2, reader.Rows(new JazminQueryOptions { Select = new[] { "Id", "Name" }, Offset = 10, Limit = 50 }).First().Count);
                Assert.Equal("ISO 3166 alpha-2", reader.Columns.Single(c => c.Name == "country_code").Description);
            }

            // 6.5
            using var stream = File.OpenRead(path);
            var names = new JazminSerializer(new JazminSerializerSettings { Key = key }).DeserializeEnumerable<GuideCustomer>(stream).Select(c => c.Name).ToList();
            Assert.Equal(20, names.Count);
        }
        finally
        {
            File.Delete(path);
        }
    }

    // 6.3: the custom converter, as written in the guide.
    public readonly record struct Money(long Cents, string Currency);

    public sealed class MoneyConverter : JazminConverter<Money>
    {
        public override JazminType ColumnType => JazminType.String;
        public override object? Write(Money value) => $"{value.Cents} {value.Currency}";
        public override Money Read(object stored)
        {
            var parts = ((string)stored).Split(' ');
            return new Money(long.Parse(parts[0]), parts[1]);
        }
    }

    public class GuideOrder
    {
        public int Id { get; set; }
        public Money Total { get; set; }
    }

    [Fact]
    public void Section6_3_NewtonsoftStyleSettings()
    {
        var settings = new JazminSerializerSettings
        {
            NamingStrategy = JazminNamingStrategy.CamelCase,
            Converters = [new MoneyConverter()],
            DefaultValueHandling = DefaultValueHandling.IgnoreAndPopulate,
            PreserveReferencesHandling = PreserveReferencesHandling.Objects,
            NestedColumns = true,
        };
        var orders = new List<GuideOrder> { new() { Id = 1, Total = new Money(1250, "ZAR") }, new() { Id = 0, Total = new Money(5, "USD") } };
        var bytes = JazminConvert.SerializeObject(orders, settings);
        var back = JazminConvert.DeserializeObject<List<GuideOrder>>(bytes, settings)!;
        Assert.Equal(orders.Select(o => (o.Id, o.Total)), back.Select(o => (o.Id, o.Total)));
        Assert.Contains("\"total\":\"1250 ZAR\"", JazminConvert.ToJson(bytes));
    }

    // 6.2: nested columns, as written in the guide.
    public class GuideCompany
    {
        public string Name { get; set; } = "";
        public List<GuideDepartment> Departments { get; set; } = [];
    }

    public class GuideDepartment
    {
        public string Name { get; set; } = "";
        public List<string> Staff { get; set; } = [];
    }

    [Fact]
    public void Section6_2_NestedColumns()
    {
        var path = Path.Combine(Path.GetTempPath(), $"guide-{Guid.NewGuid():N}.jzm");
        var companies = new List<GuideCompany> { new() { Name = "Acme", Departments = [new() { Name = "Sales", Staff = ["Ann", "Ben"] }] } };
        try
        {
            var settings = new JazminSerializerSettings { NestedColumns = true };
            File.WriteAllBytes(path, JazminConvert.SerializeObject(companies, settings));

            // Reading needs no settings: the file says how each column is stored.
            var back = JazminConvert.DeserializeObject<List<GuideCompany>>(File.ReadAllBytes(path));
            Assert.Equal(["Ann", "Ben"], back![0].Departments[0].Staff);
            using var reader = JazminReader.Open(path);
            Assert.Equal("Departments: list<object{Name: string?, Staff: list<string?>?}?>?", reader.Columns.Single(c => c.Name == "Departments").ToString());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Section15And16_AccessControlAndUpdates()
    {
        var path = Path.Combine(Path.GetTempPath(), $"guide15-{Guid.NewGuid():N}.jzm");
        var columns = new[]
        {
            new JazminColumn("section", JazminType.String),
            new JazminColumn("line", JazminType.Int),
            new JazminColumn("salary", JazminType.Float),
            new JazminColumn("idNumber", JazminType.String),
        };
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var carol = owner.CreateAccessKey();
        var bobKeyText = bob.ToString();
        try
        {
            // 15.3
            using (var writer = JazminWriter.Create(path, columns, new JazminWriteOptions
            {
                Key = owner,
                SortedBy = ["section"],
                Access = new JazminAccessOptions
                {
                    PartitionBy = "section",
                    ColumnGroups = new() { ["pii"] = ["salary", "idNumber"] },
                    Grants = [new JazminGrant(bob) { Rows = ["ACC000123"], Columns = ["*"], Label = "Bob" }],
                },
            }))
            {
                foreach (var s in new[] { "ACC000001", "ACC000123" })
                    for (var l = 0L; l < 3; l++) writer.WriteValues(s, l, 1000.0 + l, $"ID-{l}");
            }
            using (var view = JazminReader.Open(path, new JazminReadOptions { AccessKey = JazminAccessKey.Parse(bobKeyText) }))
            {
                Assert.Equal(new[] { "section", "line" }, view.Columns.Select(c => c.Name));
                Assert.Equal(3, view.RowCount);
                Assert.Equal(3, view.HiddenRowCount);
            }
            JazminFile.GrantAccess(path, owner, new JazminGrant(carol) { Label = "Auditor" });
            JazminFile.RevokeAccess(path, owner, bob);
            Assert.Throws<JazminKeyException>(() => JazminReader.Open(path, new JazminReadOptions { AccessKey = bob }));

            // 16
            var result = JazminFile.Update(path, new JazminUpdate
            {
                Key = owner,
                Insert = [new Dictionary<string, object?> { ["section"] = "ACC000124", ["line"] = 0L, ["salary"] = 10.0 }],
                Upsert = [new Dictionary<string, object?> { ["section"] = "ACC000123", ["line"] = 2L, ["salary"] = 99.0 }],
                KeyColumns = ["section", "line"],
                Delete = JazminFilter.Eq("section", "ACC000001"),
            });
            Assert.Equal(new JazminUpdateResult(4, 1, 1, 3), result);
            using var carolView = JazminReader.Open(path, new JazminReadOptions { AccessKey = carol });
            Assert.Equal(new[] { "ACC000123", "ACC000123", "ACC000123", "ACC000124" }, carolView.Rows().Select(r => (string)r["section"]!));
            Assert.Equal(99.0, carolView.Rows().Single(r => (long)r["line"]! == 2 && (string)r["section"]! == "ACC000123")["salary"]);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
