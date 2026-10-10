# JAZMIN in Blazor: LINQ in the browser (sample)

The JAZMIN .NET library running in the browser with Blazor WebAssembly. The page makes a file of two tables (250
clients and their 26,328 card transactions, the bank demo of [js/examples/from-disk](../../../js/examples/from-disk)),
then queries both tables with LINQ, in lambda and query syntax. No server is involved: the page is static files.

```bash
dotnet run --project dotnet/samples/Jazmin.Blazor        # then open http://localhost:5226
dotnet publish dotnet/samples/Jazmin.Blazor -c Release   # static files to host anywhere (bin/Release/net10.0/publish/wwwroot)
```

## What it shows

| Query | LINQ | In Chrome |
|---|---|---|
| Durban clients and their spending | `Where`, and a `Sum` over the other table per client (read once, as a lookup) | about 450 ms the first time (.NET warming up), then 70-120 ms |
| Big travel spends, with the client | query syntax: `where`, `join`, `orderby` | 70-110 ms |
| Spending per segment | `join`, `group … by … into`, `Sum`, `Count` | 100-180 ms |
| Who drinks the most coffee | `Contains(…, OrdinalIgnoreCase)`, `GroupBy`, `Take`, `Join` | 40-75 ms |

Each query is shown as it is written in `App.razor`: the compiler passes the code to the page
(`[CallerArgumentExpression]`), so what you read is what runs. Filters in `Where` run in the file, with its indexes
and sort order; joins and groups across tables run in memory, as LINQ to Objects. The results are the same as the
JavaScript demo's queries on the same data (`tables.html` in the from-disk sample).

**Your own file:** choose an unencrypted `.jzm` to see its tables, columns and first rows. It is read in the browser,
nothing is uploaded.

## Unencrypted files only

.NET in the browser has no AES-GCM and no ECDSA, which files locked with a key or password, and shared files, need:
opening one fails with `PlatformNotSupportedException`, which the page explains. For those files in a browser, use
the JAZMIN viewer or the browser reader (JavaScript, `js/browser`), which use the browser's own cryptography; or read
them with the library on a server (Blazor Server, an API).

## Good to know

- **Memory:** a chosen file is read into memory whole (Blazor gives a stream, not slices); the demo file is 179 KB.
- **Speed:** .NET in the browser runs interpreted unless published with ahead-of-time compilation
  (`<RunAOTCompilation>true</RunAOTCompilation>`, which needs the `wasm-tools` workload): the same queries take a few
  milliseconds in .NET on a server.
- `DemoData.cs` makes the demo file with `JazminWriter`, from the same random numbers as the JavaScript demo.
