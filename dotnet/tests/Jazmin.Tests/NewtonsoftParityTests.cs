using System.ComponentModel;
using System.Globalization;
using System.Text.Json.Serialization;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Newtonsoft-style options of the serializer (TASKS J-4, J-5): custom converters, naming strategies,
/// DefaultValueHandling, opt-in polymorphic types and PreserveReferencesHandling. Each round-trips, and the JSON output
/// has the shape Newtonsoft writes for the same option.
/// </summary>
public class NewtonsoftParityTests
{
    private static string Json(byte[] data) =>
        JazminConvert.ToJson(data, new JazminSerializerSettings { NullValueHandling = NullValueHandling.Ignore });

    // ---- J-4: converters ----------------------------------------------------------------------------

    public readonly record struct Money(long Cents, string Currency);

    /// <summary>Stores money as text, "12.50 ZAR".</summary>
    public sealed class MoneyConverter : JazminConverter<Money>
    {
        public override JazminType ColumnType => JazminType.String;

        public override object? Write(Money value) => $"{(value.Cents / 100m).ToString("0.00", CultureInfo.InvariantCulture)} {value.Currency}";

        public override Money Read(object stored)
        {
            var parts = ((string)stored).Split(' ');
            return new Money((long)(decimal.Parse(parts[0], CultureInfo.InvariantCulture) * 100), parts[1]);
        }
    }

    /// <summary>Upper-cases codes when writing (an attribute on the property chooses it).</summary>
    public sealed class UpperCaseConverter : JazminConverter<string>
    {
        public override JazminType ColumnType => JazminType.String;

        public override object? Write(string value) => value.ToUpperInvariant();

        public override string Read(object stored) => (string)stored;
    }

    /// <summary>A point stored as two numbers in a json column; the type's attribute chooses the converter.</summary>
    [JazminConverter(typeof(PointConverter))]
    public readonly record struct Point(int X, int Y);

    public sealed class PointConverter : JazminConverter<Point>
    {
        public override JazminType ColumnType => JazminType.Json;

        public override object? Write(Point value) => new System.Text.Json.Nodes.JsonArray(value.X, value.Y);

        public override Point Read(object stored)
        {
            var array = (System.Text.Json.Nodes.JsonArray)stored;
            return new Point((int)array[0]!, (int)array[1]!);
        }
    }

    public class Invoice
    {
        public int Id { get; set; }

        public Money Total { get; set; }

        public Money? Discount { get; set; }

        [JazminConverter(typeof(UpperCaseConverter))]
        public string? Code { get; set; }

        public Point Origin { get; set; }
    }

    private static readonly Invoice[] Invoices =
    [
        new() { Id = 1, Total = new Money(1250, "ZAR"), Discount = new Money(100, "ZAR"), Code = "abc", Origin = new Point(1, 2) },
        new() { Id = 2, Total = new Money(99, "USD"), Code = null, Origin = new Point(-3, 4) },
    ];

    [Fact]
    public void Converters_RoundTripACustomType()
    {
        var settings = new JazminSerializerSettings { Converters = [new MoneyConverter()] };
        var bytes = JazminConvert.SerializeObject(Invoices, settings);

        using (var reader = JazminReader.Open(bytes))
            Assert.Equal([JazminType.Int, JazminType.String, JazminType.String, JazminType.String, JazminType.Json], reader.Columns.Select(c => c.Type));
        Assert.Equal("""[{"Id":1,"Total":"12.50 ZAR","Discount":"1.00 ZAR","Code":"ABC","Origin":[1,2]},{"Id":2,"Total":"0.99 USD","Origin":[-3,4]}]""", Json(bytes));

        var back = JazminConvert.DeserializeObject<List<Invoice>>(bytes, settings)!; // decoded straight from the columns
        Assert.Equal(Invoices.Select(i => (i.Id, i.Total, i.Discount, i.Code?.ToUpperInvariant(), i.Origin)), back.Select(i => (i.Id, i.Total, i.Discount, i.Code, i.Origin)));
        using var r = JazminReader.Open(bytes);
        var rows = r.Query<Invoice>(i => i.Total.Currency == "USD", settings).ToList(); // a converted property: filtered in memory
        Assert.Equal([2], rows.Select(i => i.Id));
        Assert.Equal(new Money(99, "USD"), rows[0].Total);
    }

    // ---- J-5: naming strategies -----------------------------------------------------------------------

    public class Person
    {
        public int Id { get; set; }

        public string FirstName { get; set; } = "";

        [JazminProperty("surname")]
        public string LastName { get; set; } = "";

        public string? URLValue { get; set; }
    }

    [Fact]
    public void NamingStrategies_NameColumnsLikeNewtonsoft_AndExplicitNamesStay()
    {
        var people = new[] { new Person { Id = 1, FirstName = "Ann", LastName = "Lee", URLValue = "x" } };
        var camel = new JazminSerializerSettings { NamingStrategy = JazminNamingStrategy.CamelCase };
        var bytes = JazminConvert.SerializeObject(people, camel);
        Assert.Equal("""[{"id":1,"firstName":"Ann","surname":"Lee","urlValue":"x"}]""", Json(bytes));
        var back = JazminConvert.DeserializeObject<List<Person>>(bytes, camel)!.Single();
        Assert.Equal(("Ann", "Lee", "x"), (back.FirstName, back.LastName, back.URLValue));
        using (var r = JazminReader.Open(bytes))
            Assert.Equal([1], r.Query<Person>(p => p.FirstName == "Ann" && p.Id > 0, camel).Select(p => p.Id)); // pushed down by column name

        var snake = new JazminSerializerSettings { NamingStrategy = JazminNamingStrategy.SnakeCase };
        Assert.Equal("""[{"id":1,"first_name":"Ann","surname":"Lee","url_value":"x"}]""", Json(JazminConvert.SerializeObject(people, snake)));
        var kebab = new JazminSerializerSettings { NamingStrategy = JazminNamingStrategy.KebabCase };
        Assert.Equal("""[{"id":1,"first-name":"Ann","surname":"Lee","url-value":"x"}]""", Json(JazminConvert.SerializeObject(people, kebab)));
    }

    // ---- J-5: DefaultValueHandling --------------------------------------------------------------------

    public class Job
    {
        public int Id { get; set; }

        [DefaultValue(10)]
        public int Retries { get; set; } = 10;

        public bool Enabled { get; set; }

        [DefaultValue("normal")]
        public string Priority { get; set; } = "normal";
    }

    [Fact]
    public void DefaultValueHandling_IgnoreStoresDefaultsAsNull_AndPopulateFillsThemIn()
    {
        var jobs = new[]
        {
            new Job { Id = 1 },
            new Job { Id = 2, Retries = 3, Enabled = true, Priority = "high" },
        };
        var ignore = new JazminSerializerSettings { DefaultValueHandling = DefaultValueHandling.Ignore };
        var bytes = JazminConvert.SerializeObject(jobs, ignore);
        // Newtonsoft with DefaultValueHandling.Ignore omits the same members.
        Assert.Equal("""[{"Id":1},{"Id":2,"Retries":3,"Enabled":true,"Priority":"high"}]""", Json(bytes));

        var both = new JazminSerializerSettings { DefaultValueHandling = DefaultValueHandling.IgnoreAndPopulate };
        var back = JazminConvert.DeserializeObject<List<Job>>(JazminConvert.SerializeObject(jobs, both), both)!;
        Assert.Equal(jobs.Select(j => (j.Id, j.Retries, j.Enabled, j.Priority)), back.Select(j => (j.Id, j.Retries, j.Enabled, j.Priority)));

        // Populate fills in what a file does not have: a column that is missing, or null.
        var populate = new JazminSerializerSettings { DefaultValueHandling = DefaultValueHandling.Populate };
        var idsOnly = JazminConvert.SerializeObject(new[] { new Dictionary<string, object?> { ["Id"] = 5L, ["Priority"] = null } });
        var filled = JazminConvert.DeserializeObject<List<Job>>(idsOnly, populate)!.Single();
        Assert.Equal((5, 10, false, "normal"), (filled.Id, filled.Retries, filled.Enabled, filled.Priority));
        using var r = JazminReader.Open(bytes);
        Assert.Equal([1], r.Query<Job>(j => j.Retries == 10, both).Select(j => j.Id)); // defaults are null in the file: filtered in memory
    }

    // ---- J-5: polymorphic types (opt-in, closed list) ----------------------------------------------------

    [JsonDerivedType(typeof(Dog), "dog")]
    [JsonDerivedType(typeof(Cat), "cat")]
    public abstract class Animal
    {
        public string Name { get; set; } = "";
    }

    public sealed class Dog : Animal
    {
        public bool Barks { get; set; }
    }

    public sealed class Cat : Animal
    {
        public int Lives { get; set; }
    }

    public sealed class Fish : Animal;

    [JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
    [JsonDerivedType(typeof(Card), "card")]
    public class Payment
    {
        public decimal Amount { get; set; }
    }

    public sealed class Card : Payment
    {
        public string Last4 { get; set; } = "";
    }

    [Fact]
    public void PolymorphicTypes_RoundTripTheirDerivedTypes_WithADiscriminator()
    {
        var animals = new List<Animal> { new Dog { Name = "Rex", Barks = true }, new Cat { Name = "Tom", Lives = 9 } };
        var bytes = JazminConvert.SerializeObject(animals);
        Assert.Equal("""[{"$type":"dog","Name":"Rex","Barks":true},{"$type":"cat","Name":"Tom","Lives":9}]""", Json(bytes));
        var back = JazminConvert.DeserializeObject<List<Animal>>(bytes)!;
        Assert.Equal(("Rex", true), (back[0].Name, ((Dog)back[0]).Barks));
        Assert.Equal(("Tom", 9), (back[1].Name, ((Cat)back[1]).Lives));
        using (var r = JazminReader.Open(bytes))
            Assert.IsType<Cat>(r.Query<Animal>(a => a.Name == "Tom").Single());

        // Only the listed types: a file cannot name a type to load, and an unlisted type cannot be written.
        Assert.Contains("not a [JsonDerivedType]", Assert.Throws<JazminValidationException>(() => JazminConvert.SerializeObject(new List<Animal> { new Fish() })).Message);
        var forged = JazminConvert.SerializeObject(new[] { new Dictionary<string, object?> { ["$type"] = "System.Diagnostics.Process", ["Name"] = "x" } });
        Assert.Contains("Unknown type", Assert.Throws<JazminValidationException>(() => JazminConvert.DeserializeObject<List<Animal>>(forged)).Message);

        // A concrete base type, and a custom discriminator name.
        var payments = new List<Payment> { new() { Amount = 5m }, new Card { Amount = 7.5m, Last4 = "4242" } };
        var paymentBytes = JazminConvert.SerializeObject(payments);
        Assert.Equal("""[{"Amount":5},{"kind":"card","Amount":7.5,"Last4":"4242"}]""", Json(paymentBytes));
        var paymentsBack = JazminConvert.DeserializeObject<List<Payment>>(paymentBytes)!;
        Assert.Equal(typeof(Payment), paymentsBack[0].GetType());
        Assert.Equal("4242", ((Card)paymentsBack[1]).Last4);
    }

    // ---- J-5: PreserveReferencesHandling ------------------------------------------------------------

    public class Member
    {
        public string Name { get; set; } = "";
    }

    public class Team
    {
        public string Name { get; set; } = "";

        public List<Member> Members { get; set; } = new();
    }

    [Fact]
    public void PreserveReferences_StoresARepeatedObjectOnce_AndReadsBackTheSameInstance()
    {
        var a = new Member { Name = "a" };
        var b = new Member { Name = "b" };
        var settings = new JazminSerializerSettings { PreserveReferencesHandling = PreserveReferencesHandling.Objects };
        var bytes = JazminConvert.SerializeObject(new List<Member> { a, b, a }, settings);
        // The shape Newtonsoft writes with PreserveReferencesHandling.Objects.
        Assert.Equal("""[{"$id":"1","Name":"a"},{"$id":"2","Name":"b"},{"$ref":"1"}]""", Json(bytes));
        var back = JazminConvert.DeserializeObject<List<Member>>(bytes, settings)!;
        Assert.Equal(["a", "b", "a"], back.Select(m => m.Name));
        Assert.Same(back[0], back[2]);
        using (var stream = new MemoryStream(bytes))
        {
            var streamed = new JazminSerializer(settings).DeserializeEnumerable<Member>(stream).ToList();
            Assert.Same(streamed[0], streamed[2]);
        }

        // Inside a json column, references are preserved within each value (System.Text.Json's $id / $ref).
        var team = new Team { Name = "t", Members = [a, a] };
        var teamBack = JazminConvert.DeserializeObject<List<Team>>(JazminConvert.SerializeObject(new[] { team }, settings), settings)!.Single();
        Assert.Same(teamBack.Members[0], teamBack.Members[1]);
    }
}
