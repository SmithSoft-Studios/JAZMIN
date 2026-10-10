# Jazmin

**JAZMIN** is a compact, indexed, optionally encrypted file format for lists of records. This is the library for
.NET 10, shaped like Newtonsoft.Json and with no third-party dependencies. It reads and writes the same files as the
JavaScript library (npm: `@smithsoft-studios/jazmin`).

```bash
dotnet add package Jazmin
```

```csharp
using Jazmin;
using Jazmin.Serialization;

// One-liners, like Newtonsoft.Json
var key = JazminKey.Generate(); // store it safely, e.g. in a secrets vault
byte[] bytes = JazminConvert.SerializeObject(customers, new() { Key = key });
List<Customer> back = JazminConvert.DeserializeObject<List<Customer>>(bytes, new() { Key = key })!;

// Query a file: only the index pages and the chunks holding matches are read
using var reader = JazminReader.Open("customers.jzm", new() { Key = key });
var za = reader.Query<Customer>(c => c.Country == "ZA" && c.Name.Contains("Smith")).ToList();

// Or a whole LINQ query run by the reader: the condition, Skip/Take and Count read only what they need
var page = reader.AsQueryable<Customer>().Where(c => c.Country == "ZA").Skip(20).Take(10).ToList();
```

## What it does

- **Small files:** about 24× smaller than JSON, and 61% smaller than gzipped JSON.
- **Fast lookups with little memory:** a query reads the index and the matching chunks, not the whole file.
- **Encryption:** AES-256-GCM on every section, with tamper detection.
- **Access control:** one file, many keys. Each access key sees only its rows and columns, and keys can expire.
- **Several tables per file,** embedded files, and append-only updates.
- **Lists and classes as nested columns** (opt-in `NestedColumns`, or `[JazminNested]` per property): stored as columns
  of their fields, smaller and faster to read than JSON text; LINQ reads only the fields a query uses.
- **Records sent back:** people with an access key send records back in small files locked with their submission
  key, which only someone who opened the shared file has; the owner derives it to check and file them.
- **Editable documents:** `JazminFile.WriteChanges` and `ApplyChanges` make and apply the change files a document's
  readers send, with conflicts held for the owner.
- **Newtonsoft-style serializer:** attributes, converters, naming strategies, default values, polymorphism and
  references.
- **LINQ the reader runs:** `AsQueryable<T>()` turns conditions, `Skip`/`Take`, counts and sort order into one query on
  the file, reading only the columns it uses.
- **Memory or speed first,** key and password changes without rewriting rows, and rows as a JSON stream.
- **ASP.NET Core:** the `Jazmin.AspNetCore` package serves a file's embedded files from an endpoint.

Full documentation, the format specification and the JavaScript library:
[github.com/SmithSoft-Studios/JAZMIN](https://github.com/SmithSoft-Studios/JAZMIN).

MIT licence. JAZMIN™ is a trademark of SmithSoft Pty Ltd. The MIT licence covers the code, not the name: please don't
call another product or service JAZMIN, or use the JAZMIN logo for one.
