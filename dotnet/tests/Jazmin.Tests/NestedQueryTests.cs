using System.Text.Json;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// LINQ over nested columns reads only the fields a query reads, at any depth, wherever objects of that type are; the
/// other fields' streams are passed over and their members keep their defaults. Nested objects that may be read in ways
/// the query does not show (returned, passed to a method, compared, grouped by, a computed property) are read whole.
/// Results are always those of LINQ to Objects.
/// </summary>
public sealed class NestedQueryTests
{
    // Counters on one long field per level: a query that does not read it must not set it.
    public static int NotesSet, BiosSet, DescriptionsSet, StreetsSet;

    public sealed class Address
    {
        private string _street = "";
        public string City { get; set; } = "";
        public string Street { get => _street; set { _street = value; StreetsSet++; } }
    }

    public sealed class Project
    {
        private string _description = "";
        public string Name { get; set; } = "";
        public string Category { get; set; } = "";
        public decimal Revenue { get; set; }
        public string Description { get => _description; set { _description = value; DescriptionsSet++; } }
    }

    public sealed class Employee
    {
        private string _bio = "";
        public string Name { get; set; } = "";
        public string Role { get; set; } = "";
        public string Bio { get => _bio; set { _bio = value; BiosSet++; } }
        public List<Project> Projects { get; set; } = [];
    }

    public sealed class Department
    {
        private string _notes = "";
        public string Name { get; set; } = "";
        public decimal Budget { get; set; }
        public string Notes { get => _notes; set { _notes = value; NotesSet++; } }
        public Address? Location { get; set; }
        public List<Employee> Employees { get; set; } = [];
        public string Label => $"{Name} ({Budget})"; // computed: may read any field
    }

    public sealed class Company
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public Address? Head { get; set; }
        public List<Department> Departments { get; set; } = [];
    }

    private static readonly List<Company> Companies = Enumerable.Range(0, 120).Select(c => new Company
    {
        Id = c,
        Name = $"Company {c}",
        Head = c % 4 == 0 ? null : new Address { City = $"City {c % 5}", Street = $"{c} Long Street" },
        Departments = [.. new[] { "Sales", "Build", "Support" }.Take(1 + c % 3).Select((d, i) => new Department
        {
            Name = d,
            Budget = 1000 + c * 10 + i,
            Notes = $"notes {c}-{i}",
            Location = i == 1 ? null : new Address { City = $"Floor {i}", Street = $"{i} Side Street" },
            Employees = [.. Enumerable.Range(0, (c + i) % 4).Select(e => new Employee
            {
                Name = $"E{c}-{i}-{e}",
                Role = e == 0 ? "Lead" : "Member",
                Bio = $"bio {c} {i} {e}",
                Projects = [.. Enumerable.Range(0, (c + e) % 3).Select(p => new Project
                {
                    Name = $"P{c}/{i}/{e}/{p}", Category = p == 0 ? "Product" : "Service", Revenue = 2_500m * ((c + i + e + p) % 7 + 1), Description = $"description {p}",
                })],
            })],
        })],
    }).ToList();

    private static readonly JazminSerializerSettings Nested = new() { NestedColumns = true, ChunkRows = 32 };
    private static readonly byte[] File = JazminConvert.SerializeObject(Companies, Nested);

    private static string Describe(Department d) => $"{d.Name}:{d.Notes}"; // a method: what it reads does not show

    /// <summary>Runs a query over the file and over the list, compares the results, and says which long fields it read.</summary>
    private static (bool Notes, bool Bios, bool Descriptions, bool Streets) Reads<TResult>(Func<IQueryable<Company>, TResult> query)
    {
        var expected = JsonSerializer.Serialize(query(Companies.AsQueryable()));
        using var reader = JazminReader.Open(File);
        (bool, bool, bool, bool)? reads = null;
        foreach (var settings in new[] { Nested, null }) // reading needs no settings: the file says which columns are nested
        {
            (NotesSet, BiosSet, DescriptionsSet, StreetsSet) = (0, 0, 0, 0);
            Assert.Equal(expected, JsonSerializer.Serialize(query(reader.AsQueryable<Company>(settings))));
            var these = (NotesSet > 0, BiosSet > 0, DescriptionsSet > 0, StreetsSet > 0);
            Assert.Equal(reads ?? these, these);
            reads = these;
        }
        return reads!.Value;
    }

    [Fact]
    public void AReportReadsOnlyTheFieldsItUses_AtEveryDepth()
    {
        // The user's report: departments, employees and projects, six fields of them.
        Assert.Equal((false, false, false, false), Reads(q => q
            .SelectMany(c => c.Departments)
            .SelectMany(d => d.Employees, (d, e) => new { Department = d.Name, Employee = e })
            .SelectMany(x => x.Employee.Projects, (x, p) => new { Employee = x.Employee.Name, x.Department, x.Employee.Role, Project = p.Name, p.Category, p.Revenue })
            .Where(x => x.Revenue > 10_000)
            .GroupBy(x => new { x.Department, x.Category })
            .Select(g => new { g.Key.Department, g.Key.Category, Revenue = g.Sum(x => x.Revenue), Employees = g.Select(x => x.Employee).Distinct().Count(), Top = g.OrderByDescending(x => x.Revenue).First().Project })
            .OrderByDescending(x => x.Revenue).ThenBy(x => x.Department).ThenBy(x => x.Category).ToList()));
        // Counts and sums: no field of what is counted.
        Assert.Equal((false, false, false, false), Reads(q => q.Select(c => new { c.Id, Departments = c.Departments.Count, Staff = c.Departments.Sum(d => d.Employees.Count) }).ToList()));
        Assert.Equal((false, false, false, false), Reads(q => q.Select(c => c.Departments.Sum(d => d.Budget)).ToList()));
        // One company (a lookup): the same fields only.
        Assert.Equal((false, false, false, false), Reads(q => q.Where(c => c.Id == 7).SelectMany(c => c.Departments).SelectMany(d => d.Employees).Select(e => e.Name).ToList()));
        // A field of an object that is in two places (Address: a company's head, a department's location) is read at both.
        Assert.Equal((false, false, false, false), Reads(q => q.Select(c => new { City = c.Head == null ? null : c.Head.City, Floors = c.Departments.Select(d => d.Location == null ? null : d.Location.City).ToList() }).ToList()));
        // Conditions on nested fields read those fields only.
        Assert.Equal((true, false, false, false), Reads(q => q.Where(c => c.Departments.Any(d => d.Notes.EndsWith("-1"))).Select(c => c.Id).ToList()));
        Assert.Equal((false, true, false, false), Reads(q => q.SelectMany(c => c.Departments).GroupBy(d => d.Name).Select(g => new { g.Key, Bios = g.SelectMany(d => d.Employees).Count(e => e.Bio.Length > 12) }).ToList()));
    }

    [Fact]
    public void ObjectsReadInWaysTheQueryDoesNotShow_AreReadWhole()
    {
        // Returned whole: every field below.
        Assert.Equal((true, true, true, true), Reads(q => q.Select(c => c.Departments).ToList()));
        Assert.Equal((false, true, true, false), Reads(q => q.SelectMany(c => c.Departments).Select(d => new { d.Name, d.Employees }).ToList()));
        Assert.Equal((false, false, false, true), Reads(q => q.Select(c => c.Head).ToList()));
        // Passed to a method, or a computed property: the method may read any field.
        Assert.Equal((true, true, true, true), Reads(q => q.SelectMany(c => c.Departments).Select(d => Describe(d)).ToList()));
        Assert.Equal((true, true, true, true), Reads(q => q.SelectMany(c => c.Departments).Select(d => d.Label).ToList()));
        // Grouped by, or compared, whole objects: their fields are compared.
        Assert.Equal((false, false, true, false), Reads(q => q.SelectMany(c => c.Departments).SelectMany(d => d.Employees).SelectMany(e => e.Projects).GroupBy(p => p).Count()));
        // The rows themselves: every column, every field.
        Assert.Equal((true, true, true, true), Reads(q => q.Where(c => c.Id > 100).ToList()));
    }

    public sealed class Step
    {
        public string Title { get; set; } = "";
        public string Owner { get; set; } = "";
    }

    public sealed class Plan
    {
        public int Id { get; set; }
        public List<Step> Steps { get; set; } = [];
    }

    public sealed class StepLater
    {
        public string Title { get; set; } = "";
        public string Owner { get; set; } = "";
        public int? Hours { get; set; }
    }

    public sealed class PlanLater
    {
        public int Id { get; set; }
        public List<StepLater> Steps { get; set; } = [];
    }

    [Fact]
    public void AFieldAddedByAppending_IsNullInEarlierChunks_WhenOnlySomeFieldsAreRead()
    {
        var path = Path.Combine(Path.GetTempPath(), $"jazmin-plans-{Guid.NewGuid():N}.jzm");
        try
        {
            System.IO.File.WriteAllBytes(path, JazminConvert.SerializeObject(Enumerable.Range(0, 30).Select(i => new Plan { Id = i, Steps = [new() { Title = $"t{i}", Owner = "a" }] }).ToList(), Nested));
            JazminFile.Append(path, new JazminAppend
            {
                Insert = [.. Enumerable.Range(30, 30).Select(i => (IReadOnlyDictionary<string, object?>)new Dictionary<string, object?>
                {
                    ["Id"] = (long)i, ["Steps"] = new List<StepLater> { new() { Title = $"t{i}", Owner = "b", Hours = i } },
                })],
            });
            using var reader = JazminReader.Open(path);
            var hours = reader.AsQueryable<PlanLater>(Nested).SelectMany(p => p.Steps).Select(s => s.Hours).ToList(); // Title and Owner not read
            Assert.Equal(Enumerable.Repeat<int?>(null, 30).Concat(Enumerable.Range(30, 30).Select(i => (int?)i)), hours);
            Assert.Equal([null], reader.AsQueryable<PlanLater>(Nested).Where(p => p.Id == 3).SelectMany(p => p.Steps).Select(s => s.Hours).ToList());
        }
        finally
        {
            System.IO.File.Delete(path);
        }
    }

    [Fact]
    public void ItemsAndObjectsNotRead_KeepTheirDefaults_AndTheRowsOfAScanAreAllThere()
    {
        // Values of fields read come through; fields not read are passed over in every chunk (a scan, then a lookup).
        using var reader = JazminReader.Open(File);
        var budgets = reader.AsQueryable<Company>(Nested).SelectMany(c => c.Departments).Select(d => d.Budget).ToList();
        Assert.Equal(Companies.SelectMany(c => c.Departments).Select(d => d.Budget), budgets);
        var one = reader.AsQueryable<Company>(Nested).Where(c => c.Id == 118).Select(c => c.Departments.Select(d => d.Employees.Select(e => e.Projects.Count).ToList()).ToList()).Single();
        Assert.Equal(Companies[118].Departments.Select(d => d.Employees.Select(e => e.Projects.Count).ToList()).ToList(), one);
    }
}
