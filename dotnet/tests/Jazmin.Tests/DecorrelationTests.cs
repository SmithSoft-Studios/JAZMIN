using System.Text.Json;
using Jazmin.Query;
using Jazmin.Serialization;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Sub-queries of other tables inside a query's lambdas (a query per outer row, "N+1") are read once: as a lookup when
/// their condition pairs a member with a value of the outer row, otherwise as LINQ to Objects over their rows. Results
/// are always those of LINQ to Objects over lists; the first rows still run their own queries, so a query for one
/// customer reads no whole table.
/// </summary>
public sealed class DecorrelationTests
{
    public sealed class Customer
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public string Region { get; set; } = "";
        public int? ManagerId { get; set; }
        public decimal Limit { get; set; }
    }

    public sealed class Order
    {
        public int Id { get; set; }
        public int CustomerId { get; set; }
        public int? ManagerId { get; set; }
        public int ProductId { get; set; }
        public int Quantity { get; set; }
        public decimal Price { get; set; }
        public string Region { get; set; } = "";
        public DateTime Date { get; set; }
    }

    public sealed class Product
    {
        public int Id { get; set; }
        public string Name { get; set; } = "";
        public string Category { get; set; } = "";
    }

    private static readonly List<Customer> Customers = Enumerable.Range(1, 60).Select(i => new Customer
    {
        Id = i, Name = $"C{i}", Region = new[] { "ZA", "NA", "BW" }[i % 3], ManagerId = i % 4 == 0 ? null : i % 5, Limit = i % 2 == 0 ? 7.5m : 7.50m + i,
    }).ToList();

    private static readonly List<Order> Orders = Enumerable.Range(1, 400).Select(i => new Order
    {
        Id = i, CustomerId = 1 + i * 37 % 70, ManagerId = i % 6 == 0 ? null : i % 5, ProductId = 1 + i % 25, Quantity = 1 + i % 9, Price = i % 3 == 0 ? 7.5m : 7.50m + i % 4,
        Region = new[] { "ZA", "NA", "BW", "KE" }[i % 4], Date = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddDays(i % 50),
    }).ToList(); // customers 61-70 do not exist; customers with no orders exist

    private static readonly List<Product> Products = Enumerable.Range(1, 25).Select(i => new Product { Id = i, Name = $"P{i}", Category = i % 2 == 0 ? "Tools" : "Garden" }).ToList();

    private static readonly byte[] File = Write();

    private static byte[] Write()
    {
        var (c, o, p) = (TypeMap.For(typeof(Customer)), TypeMap.For(typeof(Order)), TypeMap.For(typeof(Product)));
        using var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, new JazminWriteOptions
        {
            Tables = [new JazminTable("customers", c.Columns), new JazminTable("orders", o.Columns) { ChunkRows = 64 }, new JazminTable("products", p.Columns)],
        }, leaveOpen: true))
        {
            foreach (var x in Customers) writer.WriteValues(c.ToValues(x, null));
            writer.StartTable("orders");
            foreach (var x in Orders) writer.WriteValues(o.ToValues(x, null));
            writer.StartTable("products");
            foreach (var x in Products) writer.WriteValues(p.ToValues(x, null));
        }
        return stream.ToArray();
    }

    private sealed class Tables : IDisposable
    {
        private readonly JazminReader _customers = JazminReader.Open(File);
        private readonly JazminReader _orders;
        private readonly JazminReader _products;

        public Tables()
        {
            _orders = _customers.OpenTable("orders");
            _products = _customers.OpenTable("products");
            (C, O, P) = (_customers.AsQueryable<Customer>(), _orders.AsQueryable<Order>(), _products.AsQueryable<Product>());
        }

        public IQueryable<Customer> C { get; }
        public IQueryable<Order> O { get; }
        public IQueryable<Product> P { get; }

        public int Planned(IQueryable q) => q.Provider switch
        {
            JazminQueryProvider<Order> o => o.Plans,
            JazminQueryProvider<Product> p => p.Plans,
            _ => throw new ArgumentException("not a table"),
        };

        public void Dispose()
        {
            _products.Dispose();
            _orders.Dispose();
            _customers.Dispose();
        }
    }

    /// <summary>A query over the file gives what it gives over lists.</summary>
    private static void Same<TResult>(Func<IQueryable<Customer>, IQueryable<Order>, IQueryable<Product>, TResult> query)
    {
        var expected = JsonSerializer.Serialize(query(Customers.AsQueryable(), Orders.AsQueryable(), Products.AsQueryable()));
        using var t = new Tables();
        Assert.Equal(expected, JsonSerializer.Serialize(query(t.C, t.O, t.P)));
    }

    [Fact]
    public void SubQueriesPerOuterRow_GiveLinqToObjectsResults()
    {
        // The user's shapes: the latest orders of each customer with their product, and a report over all of them.
        Same((c, o, p) => c.Select(x => new
        {
            x.Name,
            Orders = o.Where(y => y.CustomerId == x.Id).OrderByDescending(y => y.Date).ThenBy(y => y.Id).Take(3).Select(y => new
            {
                y.Id,
                Product = p.Where(z => z.Id == y.ProductId).Select(z => z.Name).FirstOrDefault(),
            }).ToList(),
        }).ToList());
        Same((c, o, p) => c.SelectMany(x => o.Where(y => y.CustomerId == x.Id).Select(y => new { x.Region, Order = y, Product = p.First(z => z.Id == y.ProductId) }))
            .GroupBy(x => new { x.Region, x.Product.Category })
            .Select(g => new { g.Key.Region, g.Key.Category, Orders = g.Count(), Revenue = g.Sum(x => x.Order.Quantity * x.Order.Price) })
            .OrderBy(x => x.Region).ThenBy(x => x.Category).ToList());

        // Keys: nullable (null equals null in C#), text, decimal by value (7.5 == 7.50).
        Same((c, o, p) => c.Select(x => o.Count(y => y.ManagerId == x.ManagerId)).ToList());
        Same((c, o, p) => c.Select(x => o.Where(y => y.Region == x.Region).Sum(y => y.Quantity)).ToList());
        Same((c, o, p) => c.Select(x => o.Where(y => x.Limit == y.Price).Select(y => y.Id).ToList()).ToList());

        // More conditions: on the sub-query alone, and on the outer row too.
        Same((c, o, p) => c.Select(x => o.Where(y => y.CustomerId == x.Id && y.Quantity > 3 && y.Price > x.Limit / 2).Select(y => y.Id).ToList()).ToList());
        // No pairing: compared otherwise, or not with the outer row at all.
        Same((c, o, p) => c.Select(x => o.Count(y => y.CustomerId > x.Id * 10)).ToList());
        Same((c, o, p) => c.Select(x => new { x.Id, Products = p.Count(), Tools = p.Where(z => z.Category == "Tools").Select(z => z.Id).ToList() }).ToList());
        // A queryable kept in the result, enumerated afterwards.
        Same((c, o, p) => c.Where(x => x.Id < 20).Select(x => new { x.Id, Their = o.Where(y => y.CustomerId == x.Id) }).AsEnumerable()
            .Select(x => new { x.Id, Ids = x.Their.Select(y => y.Id).ToList() }).ToList());
        // A query captured from outside, with conditions of its own.
        Same((c, o, p) =>
        {
            var big = o.Where(y => y.Quantity > 5);
            return c.Select(x => big.Count(y => y.CustomerId == x.Id)).ToList();
        });
    }

    [Fact]
    public void ASubQueryFails_AsLinqToObjectsFails()
    {
        // No order has 100 items: First finds none, for the first customer as for the later ones (read once).
        var expected = Record.Exception(() => Customers.AsQueryable().Select(x => Orders.AsQueryable().First(y => y.CustomerId == x.Id && y.Quantity > 100)).ToList());
        using var t = new Tables();
        Assert.IsType(expected!.GetType(), Record.Exception(() => t.C.Select(x => t.O.First(y => y.CustomerId == x.Id && y.Quantity > 100)).ToList()));
        var skipFirst = Customers.AsQueryable().Select(x => Orders.AsQueryable().Where(y => y.CustomerId == x.Id).Select(y => y.Id).DefaultIfEmpty(-1).First()).ToList();
        Assert.Equal(skipFirst, t.C.Select(x => t.O.Where(y => y.CustomerId == x.Id).Select(y => y.Id).DefaultIfEmpty(-1).First()).ToList());
    }

    [Fact]
    public void ManyOuterRows_ReadEachTableOnce_AndOneOuterRow_ReadsNoWholeTable()
    {
        using (var t = new Tables())
        {
            var o = t.O;
            var p = t.P;
            var all = t.C.Select(x => o.Where(y => y.CustomerId == x.Id).Select(y => p.First(z => z.Id == y.ProductId).Name).ToList()).ToList();
            Assert.Equal(Customers.Count, all.Count);
            Assert.True(t.Planned(o) <= 6, $"orders planned {t.Planned(o)} times"); // a few per-row queries, then read once
            Assert.True(t.Planned(p) <= 6, $"products planned {t.Planned(p)} times");
        }
        using (var t = new Tables())
        {
            var o = t.O;
            var one = t.C.Where(x => x.Id == 7).Select(x => o.Where(y => y.CustomerId == x.Id).Select(y => y.Id).ToList()).Single();
            Assert.Equal(Orders.Where(y => y.CustomerId == 7).Select(y => y.Id), one);
            Assert.Equal(1, t.Planned(o)); // its own query: no lookup built
        }
    }
}
