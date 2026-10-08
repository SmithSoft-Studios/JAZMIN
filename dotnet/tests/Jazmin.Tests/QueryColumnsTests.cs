using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// <c>AsQueryable&lt;T&gt;()</c> reads only the columns of the members a query reads, wherever it reads them: through
/// SelectMany, GroupBy, Join, nested queries, anonymous objects and groups. Rows that may be read in ways the query does
/// not show (returned, passed to a method, compared or sorted whole, cast) read every column. Results are always those
/// of LINQ to Objects.
/// </summary>
public sealed class QueryColumnsTests
{
    /// <summary>Counts the times Name and Note are set: a query that does not use them must not read them.</summary>
    public sealed class Row
    {
        public static int NamesSet;
        public static int NotesSet;
        private string _name = "";
        private string? _note;

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

        public string? Note
        {
            get => _note;
            set
            {
                _note = value;
                NotesSet++;
            }
        }

        public string Region { get; set; } = "";

        public decimal Amount { get; set; }

        public List<int> Parts { get; set; } = [];

        public string Upper => Name.ToUpperInvariant(); // computed: not stored

        public override string ToString() => $"{Id} {Name}";
    }

    private static readonly List<Row> Rows = Enumerable.Range(0, 200).Select(i => new Row
    {
        Id = i,
        Name = $"name {i % 17}",
        Note = i % 4 == 0 ? null : $"note {i}",
        Region = new[] { "ZA", "NA", "BW" }[i % 3],
        Amount = i * 2.5m,
        Parts = [i % 5, i % 7],
    }).ToList();

    private static readonly byte[] File = JazminConvert.SerializeObject(Rows, new JazminSerializerSettings { ChunkRows = 32 });

    private static string Text(Row r) => $"{r.Id}|{r.Name}|{r.Note}|{r.Region}|{r.Amount}|{string.Join(",", r.Parts)}";

    /// <summary>Runs a query over the file and over the list, compares the results, and says whether Name or Note was read.</summary>
    private static bool ReadsNameOrNote<TResult>(Func<IQueryable<Row>, TResult> query, Func<TResult, object>? describe = null)
    {
        describe ??= r => r is System.Collections.IEnumerable items and not string ? string.Join("\n", items.Cast<object?>().Select(x => x is Row row ? Text(row) : x?.ToString())) : r!;
        using var reader = JazminReader.Open(File);
        var expected = describe(query(Rows.AsQueryable()));
        (Row.NamesSet, Row.NotesSet) = (0, 0);
        var actual = describe(query(reader.AsQueryable<Row>()));
        var read = Row.NamesSet + Row.NotesSet > 0;
        Assert.Equal(expected, actual);
        return read;
    }

    [Fact]
    public void QueriesThatReadSomeMembers_ReadOnlyTheirColumns_AtAnyDepth()
    {
        Assert.False(ReadsNameOrNote(q => q.GroupBy(r => r.Region).Select(g => new { g.Key, Total = g.Sum(r => r.Amount), Count = g.Count() }).OrderBy(x => x.Key).ToList()));
        Assert.False(ReadsNameOrNote(q => q.SelectMany(r => r.Parts, (r, p) => new { r.Id, p }).Where(x => x.p > 3).Select(x => x.Id * 10 + x.p).ToList()));
        Assert.False(ReadsNameOrNote(q => q.Select(r => new { Row = r, r.Id }).Where(x => x.Id % 7 == 0).Select(x => x.Row.Region + x.Row.Amount).ToList()));
        Assert.False(ReadsNameOrNote(q => q.GroupBy(r => r.Region).Select(g => g.OrderByDescending(r => r.Amount).First().Id).ToList()));
        Assert.False(ReadsNameOrNote(q => q.GroupBy(r => r.Region, (k, rs) => new { k, Top = rs.MaxBy(r => r.Amount)!.Id }).ToList()));
        Assert.False(ReadsNameOrNote(q => q.Where(r => r.Id < 30).Join(q.Where(r => r.Id < 30), a => a.Region, b => b.Region, (a, b) => new { a.Id, B = b.Id })
            .OrderBy(x => x.Id).ThenBy(x => x.B).ToList()));
        Assert.False(ReadsNameOrNote(q => q.Select(r => r.Id > 100 ? r.Region : "low").Distinct().OrderBy(x => x).ToList()));
        Assert.False(ReadsNameOrNote(q => q.Aggregate(0m, (sum, r) => sum + r.Amount)));
        Assert.False(ReadsNameOrNote(q => (from r in q where r.Amount > 100 group r by r.Region into g select new { g.Key, Ids = g.Select(r => r.Id).Count() }).ToList()));

        Assert.True(ReadsNameOrNote(q => q.GroupBy(r => r.Region).Select(g => new { g.Key, Names = g.Select(r => r.Name).Distinct().Count() }).ToList())); // Name used
    }

    [Fact]
    public void RowsThatMayBeReadInWaysTheQueryDoesNotShow_ReadEveryColumn()
    {
        Assert.True(ReadsNameOrNote(q => q.Where(r => r.Id < 5).ToList())); // returned
        Assert.True(ReadsNameOrNote(q => q.ToList().Where(r => r.Id < 5).Count())); // materialized by ToList before the rest
        Assert.True(ReadsNameOrNote(q => q.Select(r => new { r, r.Id }).Take(3).ToList(), x => string.Join(";", x.Select(a => Text(a.r))))); // returned inside objects
        Assert.True(ReadsNameOrNote(q => q.Select(r => Text(r)).Take(3).ToList())); // passed to a method
        Assert.True(ReadsNameOrNote(q => q.Select(r => r.ToString()).Take(3).ToList())); // a method of the row
        Assert.True(ReadsNameOrNote(q => q.Select(r => r.Upper).Take(3).ToList())); // a computed property
        Assert.True(ReadsNameOrNote(q => q.Select(r => $"{r}").Take(3).ToList())); // formatted
        Assert.True(ReadsNameOrNote(q => q.Cast<object>().Count())); // cast
        Assert.True(ReadsNameOrNote(q => q.GroupBy(r => r).Count())); // a key of whole rows: their equality
        Assert.True(ReadsNameOrNote(q => q.Where(r => r.Id < 10).Distinct().Count())); // equality of whole rows
        Assert.True(ReadsNameOrNote(q => q.OrderBy(r => r.Id).First(), Text)); // returned
    }

    public sealed class Client
    {
        public string ClientId { get; set; } = "";

        public string Name { get; set; } = "";

        public string Region { get; set; } = "";
    }

    /// <summary>Counts the times Memo is set.</summary>
    public sealed class Payment
    {
        public static int MemosSet;
        private string _memo = "";

        public string ClientId { get; set; } = "";

        public decimal Amount { get; set; }

        public string Memo
        {
            get => _memo;
            set
            {
                _memo = value;
                MemosSet++;
            }
        }
    }

    [Fact]
    public void AJoinWithAnotherTable_ReadsOnlyTheColumnsItUsesOfEach()
    {
        var clientList = Enumerable.Range(0, 40).Select(i => new Client { ClientId = $"C{i:D2}", Name = $"Client {i}", Region = i % 2 == 0 ? "ZA" : "NA" }).ToList();
        var paymentList = Enumerable.Range(0, 300).Select(i => new Payment { ClientId = $"C{i % 45:D2}", Amount = i, Memo = $"memo {i}" }).ToList();
        var (clientMap, paymentMap) = (TypeMap.For(typeof(Client)), TypeMap.For(typeof(Payment)));
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, new JazminWriteOptions
        {
            Tables = [new JazminTable("clients", clientMap.Columns), new JazminTable("payments", paymentMap.Columns) { ChunkRows = 64 }],
        }, leaveOpen: true))
        {
            foreach (var client in clientList) writer.WriteValues(clientMap.ToValues(client, null));
            writer.StartTable("payments");
            foreach (var payment in paymentList) writer.WriteValues(paymentMap.ToValues(payment, null));
        }
        using var clients = JazminReader.Open(stream.ToArray());
        using var payments = clients.OpenTable("payments");
        var (c, p) = (clients.AsQueryable<Client>(), payments.AsQueryable<Payment>());

        var expected = clientList.Join(paymentList, x => x.ClientId, y => y.ClientId, (x, y) => new { x.Name, y.Amount }).ToList();
        Payment.MemosSet = 0;
        Assert.Equal(expected, c.Join(p, x => x.ClientId, y => y.ClientId, (x, y) => new { x.Name, y.Amount }).ToList());
        Assert.Equal(0, Payment.MemosSet);

        var totals = from x in clientList.AsQueryable()
                     join y in paymentList.AsQueryable().Where(y => y.Amount > 50) on x.ClientId equals y.ClientId
                     group y.Amount by x.Region into g
                     select new { g.Key, Total = g.Sum() };
        var read = from x in c
                   join y in p.Where(y => y.Amount > 50) on x.ClientId equals y.ClientId
                   group y.Amount by x.Region into g
                   select new { g.Key, Total = g.Sum() };
        Assert.Equal(totals.ToList(), read.ToList());
        Assert.Equal(0, Payment.MemosSet);

        var theirs = c.Join(p, x => x.ClientId, y => y.ClientId, (x, y) => y).ToList(); // the payments returned: every column
        Assert.Equal(paymentList.Where(y => y.ClientId.CompareTo("C40") < 0).Select(y => y.Memo).Order(), theirs.Select(y => y.Memo).Order());
    }

    public sealed class Company
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

        public List<Department> Departments { get; set; } = [];
    }

    public sealed class Department
    {
        public string Name { get; set; } = "";

        public List<Employee> Employees { get; set; } = [];
    }

    public sealed class Employee
    {
        public string Name { get; set; } = "";

        public string Role { get; set; } = "";

        public decimal Salary { get; set; }

        public List<Project> Projects { get; set; } = [];
    }

    public sealed class Project
    {
        public string Name { get; set; } = "";

        public string Category { get; set; } = "";

        public decimal Revenue { get; set; }
    }

    [Fact]
    public void NestedCollections_AQueryOverThemReadsOnlyTheirColumn()
    {
        var companies = Enumerable.Range(0, 12).Select(c => new Company
        {
            Id = c,
            Name = $"Company {c}",
            Departments = Enumerable.Range(0, 3).Select(d => new Department
            {
                Name = new[] { "Sales", "Build", "Support" }[d],
                Employees = Enumerable.Range(0, 4).Select(e => new Employee
                {
                    Name = $"E{c}-{d}-{e}",
                    Role = e == 0 ? "Lead" : "Member",
                    Salary = 1000 * (e + 1),
                    Projects = Enumerable.Range(0, 2).Select(p => new Project
                    {
                        Name = $"P{c}{d}{e}{p}",
                        Category = p == 0 ? "Product" : "Service",
                        Revenue = 2_500 * (c + d + e + p + 1),
                    }).ToList(),
                }).ToList(),
            }).ToList(),
        }).ToList();
        using var reader = JazminReader.Open(JazminConvert.SerializeObject(companies));

        static IEnumerable<object> Report(IQueryable<Company> source) => source
            .SelectMany(c => c.Departments)
            .SelectMany(d => d.Employees, (d, e) => new { Department = d.Name, Employee = e })
            .SelectMany(x => x.Employee.Projects, (x, p) => new
            {
                Employee = x.Employee.Name,
                x.Department,
                x.Employee.Role,
                x.Employee.Salary,
                Project = p.Name,
                p.Category,
                p.Revenue,
            })
            .Where(x => x.Revenue > 10_000)
            .GroupBy(x => new { x.Department, x.Category })
            .Select(g => new
            {
                g.Key.Department,
                g.Key.Category,
                Revenue = g.Sum(x => x.Revenue),
                Employees = g.Select(x => x.Employee).Distinct().Count(),
                TopProject = g.OrderByDescending(x => x.Revenue).First().Project,
            })
            .OrderByDescending(x => x.Revenue);

        var expected = Report(companies.AsQueryable()).ToList();
        Company.NamesSet = 0;
        Assert.Equal(expected, Report(reader.AsQueryable<Company>()).ToList());
        Assert.Equal(0, Company.NamesSet); // only the Departments column was read
        Assert.Equal(6, expected.Count);
    }
}
