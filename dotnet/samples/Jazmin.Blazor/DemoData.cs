using System.Globalization;

namespace Jazmin.Blazor;

/// <summary>A bank's client (the clients table), as LINQ reads it.</summary>
public sealed class Client
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public string City { get; set; } = "";
    public string Segment { get; set; } = "";
    public DateTime Since { get; set; }
}

/// <summary>A card transaction (the transactions table), as LINQ reads it.</summary>
public sealed class Transaction
{
    public long Client { get; set; }
    public DateTime Date { get; set; }
    public string Merchant { get; set; } = "";
    public string Category { get; set; } = "";
    public decimal Amount { get; set; }
}

/// <summary>
/// The bank demo of the from-disk sample (js/examples/from-disk/demo-data.mjs), made here: 250 clients and a year of
/// their card transactions, the same kind of data from the same random numbers, written into one file of two tables.
/// </summary>
public static class DemoData
{
    private sealed record Category(string Name, int Weight, double Min, double Max, string[] Merchants);

    private static readonly Category[] Categories =
    [
        new("Groceries", 24, 85, 2400, ["Fresh Market", "City Grocer", "Green Valley Foods", "Corner Deli", "Harbour Fish Market", "Sunrise Bakery"]),
        new("Dining", 18, 45, 950, ["Bean There Coffee", "Coffee Corner", "Pasta Place", "Sushi Bay", "Burger Joint", "The Tea Room"]),
        new("Transport", 16, 28, 1450, ["RideNow", "City Rail", "Fuel Stop", "Parking Garage", "Toll Road"]),
        new("Shopping", 12, 99, 12500, ["Online Mall", "Bookworm Books", "Tech Store", "Home & Garden", "Fashion Hub"]),
        new("Utilities", 7, 199, 2900, ["City Power", "Water Works", "FibreNet", "Mobile Telecom"]),
        new("Entertainment", 8, 59, 650, ["Streamflix", "Music Stream", "Cinema Nouveau", "Game Store"]),
        new("Health", 6, 120, 3600, ["Pharmacy Plus", "Dental Care", "Fitness Club"]),
        new("Travel", 3, 950, 26000, ["SkyHigh Airlines", "Coastal Hotels", "Car Rentals"]),
    ];
    private static readonly string[] Cities = ["Cape Town", "Johannesburg", "Durban", "Pretoria", "Gqeberha", "Bloemfontein", "Stellenbosch", "East London"];
    private static readonly string[] FirstNames = ["Thandi", "Johan", "Aisha", "Pieter", "Lerato", "Sipho", "Megan", "Ravi", "Nomvula", "David", "Zanele", "Michael",
        "Fatima", "Kagiso", "Sarah", "Andile", "Chloe", "Tshepo", "Priya", "Willem", "Naledi", "Ethan", "Amahle", "Ruan"];
    private static readonly string[] LastNames = ["Nkosi", "van der Merwe", "Patel", "Botha", "Mokoena", "Dlamini", "Smith", "Naidoo", "Khumalo", "Jacobs", "Mahlangu",
        "Pillay", "le Roux", "Ndlovu", "Adams", "Molefe", "Fourie", "Govender"];

    /// <summary>mulberry32: a small, fast random number generator, the same numbers for the same seed (as in JavaScript).</summary>
    private static Func<double> Random(uint seed)
    {
        var a = seed;
        return () =>
        {
            a += 0x6d2b79f5;
            var t = a;
            t = (t ^ (t >> 15)) * (t | 1);
            t ^= t + (t ^ (t >> 7)) * (t | 61);
            return (t ^ (t >> 14)) / 4294967296.0;
        };
    }

    private static decimal Money(double value) => decimal.Parse(value.ToString("F2", CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);

    private static T Pick<T>(Func<double> rnd, T[] list) => list[(int)Math.Floor(rnd() * list.Length)];

    /// <summary>The file: clients sorted by id, transactions by client and date, written in memory.</summary>
    public static byte[] BankFile()
    {
        var rnd = Random(77);
        var totalWeight = Categories.Sum(c => c.Weight);
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, new JazminWriteOptions
        {
            Tables =
            [
                new JazminTable("clients", [
                    new("id", JazminType.Int) { Nullable = false }, new("name", JazminType.String) { Indexes = [JazminIndexKind.Trigram] },
                    new("city", JazminType.String), new("segment", JazminType.String), new("since", JazminType.DateTime),
                ]) { SortedBy = ["id"] },
                new JazminTable("transactions", [
                    new("client", JazminType.Int) { Nullable = false }, new("date", JazminType.DateTime), new("merchant", JazminType.String),
                    new("category", JazminType.String), new("amount", JazminType.Decimal),
                ]) { SortedBy = ["client", "date"] },
            ],
            Metadata = new() { ["title"] = "Clients and their card transactions, 2026 (demo data)", ["currency"] = "ZAR" },
        }, leaveOpen: true))
        {
            var transactions = new List<object?[]>();
            for (long id = 1; id <= 250; id++)
            {
                var segment = rnd() < 0.68 ? "Personal" : rnd() < 0.6 ? "Business" : "Private";
                var name = $"{Pick(rnd, FirstNames)} {Pick(rnd, LastNames)}";
                var city = Pick(rnd, Cities);
                var since = new DateTime(2009 + (int)Math.Floor(rnd() * 17), 1 + (int)Math.Floor(rnd() * 12), 1 + (int)Math.Floor(rnd() * 28), 0, 0, 0, DateTimeKind.Utc);
                writer.WriteValues(id, name, city, segment, since);
                var privateClient = segment == "Private";
                var salary = Math.Floor((privateClient ? 60000 : 16000) + rnd() * (privateClient ? 90000 : 50000) + 0.5);
                var own = new List<(DateTime Date, string Merchant, string Category, decimal Amount)>();
                for (var month = 1; month <= 12; month++) own.Add((new DateTime(2026, month, 25, 6, 0, 0, DateTimeKind.Utc), "Salary", "Income", Money(salary)));
                var purchases = (int)Math.Floor(40 + rnd() * 110 + 0.5);
                for (var k = 0; k < purchases; k++)
                {
                    var pick = rnd() * totalWeight;
                    var category = Categories.FirstOrDefault(c => (pick -= c.Weight) < 0) ?? Categories[0];
                    var merchant = Pick(rnd, category.Merchants);
                    var amount = category.Min + (category.Max - category.Min) * Math.Pow(rnd(), 2.2);
                    var date = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddHours(Math.Floor(rnd() * 365 * 24));
                    own.Add((date, merchant, category.Name, Money(-amount)));
                }
                foreach (var t in own.OrderBy(t => t.Date)) transactions.Add([id, t.Date, t.Merchant, t.Category, t.Amount]);
            }
            writer.StartTable("transactions");
            foreach (var t in transactions) writer.WriteValues(t);
        }
        return stream.ToArray();
    }
}
