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
```

## What it does

- **Small files:** about 24× smaller than JSON, and 61% smaller than gzipped JSON.
- **Fast lookups with little memory:** a query reads the index and the matching chunks, not the whole file.
- **Encryption:** AES-256-GCM on every section, with tamper detection.
- **Access control:** one file, many keys. Each access key sees only its rows and columns, and keys can expire.
- **Several tables per file,** embedded files, and append-only updates.
- **Newtonsoft-style serializer:** attributes, converters, naming strategies, default values, polymorphism and
  references.

Full documentation, the format specification and the JavaScript library:
[github.com/SmithSoft-Studios/JAZMIN](https://github.com/SmithSoft-Studios/JAZMIN).

MIT licence.
