# Jazmin.AspNetCore

ASP.NET Core endpoints for [JAZMIN](https://github.com/SmithSoft-Studios/JAZMIN) (`.jzm`) files.

```csharp
using Jazmin;
using Jazmin.AspNetCore;

var app = WebApplication.Create(args);

// /docs/42/invoices/2026-03.pdf serves that embedded file of statements/42.jzm, read with this person's access key.
app.MapJazminFiles("/docs/{id}", async context =>
{
    var id = (string)context.Request.RouteValues["id"]!;
    var key = await keys.AccessKeyFor(context.User, id);   // your lookup; null: 404
    return key is null ? null : new JazminFileSource($"statements/{id}.jzm", new JazminReadOptions { AccessKey = key });
}).RequireAuthorization();

app.Run();
```

- **Only what the key can see** is served: other files answer 404, as if absent. A key that cannot open the file
  (wrong, expired, revoked) answers 403.
- **Byte ranges** are read from the blocks they fall in, so videos stream and seek without reading the whole file.
- **ETags** are the files' SHA-256: an unchanged file answers 304.
- **Pages and SVG are sandboxed** with the JAZMIN viewer's document policy, so a stored page cannot act as your site.
  To show a file's document, open the `.jzm` in the JAZMIN viewer.

See the [user guide](https://github.com/SmithSoft-Studios/JAZMIN/blob/main/docs/USER-GUIDE.md), section 19.
