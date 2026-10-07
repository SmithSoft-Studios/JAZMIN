using System.Diagnostics.CodeAnalysis;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Net.Http.Headers;

namespace Jazmin.AspNetCore;

/// <summary>The .jzm file a request reads, and how to open it (its key, password or access key).</summary>
public sealed record JazminFileSource(string Path, JazminReadOptions Options);

/// <summary>How <see cref="JazminEndpointRouteBuilderExtensions.MapJazminFiles"/> serves files.</summary>
public sealed class JazminFilesOptions
{
    /// <summary>
    /// Pages and SVG (types a browser runs script in) are served sandboxed (default), so a stored page cannot act as
    /// your site. Turn it off only for files served from an origin of their own.
    /// </summary>
    public bool Sandbox { get; set; } = true;

    /// <summary>Where the files are served from, for the document policy (default: the same origin, "'self'").</summary>
    public string Origin { get; set; } = "'self'";

    /// <summary>The Cache-Control header (default "private, no-cache": the browser checks the ETag each time).</summary>
    public string CacheControl { get; set; } = "private, no-cache";
}

/// <summary>ASP.NET Core endpoints for JAZMIN files.</summary>
public static partial class JazminEndpointRouteBuilderExtensions
{
    /// <summary>
    /// Serves the embedded files of .jzm files at <c>{pattern}/{path}</c> (GET and HEAD): for example
    /// <c>app.MapJazminFiles("/docs/{id}", ctx => ...)</c> serves <c>/docs/42/invoices/2026-03.pdf</c>.
    /// <paramref name="resolver"/> picks the file and the key for a request (from its route values and user), or null
    /// for 404; each request opens the file with that key, so it serves only the files that key can see.
    /// <list type="bullet">
    /// <item>Byte ranges (one per request) are read from the blocks they fall in, so videos stream and seek.</item>
    /// <item>ETags are the files' SHA-256 (304 when unchanged).</item>
    /// <item>Pages and SVG get the viewer's document policy and, by default, a sandbox.</item>
    /// <item>A key that cannot open the file (wrong, expired, revoked) answers 403.</item>
    /// </list>
    /// </summary>
    public static RouteHandlerBuilder MapJazminFiles(this IEndpointRouteBuilder endpoints, [StringSyntax("Route")] string pattern,
        Func<HttpContext, ValueTask<JazminFileSource?>> resolver, JazminFilesOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(resolver);
        var settings = options ?? new JazminFilesOptions();
        return endpoints.MapMethods($"{pattern.TrimEnd('/')}/{{**jazminPath}}", [HttpMethods.Get, HttpMethods.Head],
            (Delegate)((HttpContext context) => ServeAsync(context, resolver, settings))); // a route handler: its IResult is written
    }

    private static async Task<IResult> ServeAsync(HttpContext context, Func<HttpContext, ValueTask<JazminFileSource?>> resolver, JazminFilesOptions settings)
    {
        var path = context.Request.RouteValues["jazminPath"] as string;
        if (string.IsNullOrEmpty(path) || await resolver(context) is not { } source) return Results.NotFound();
        JazminReader reader;
        try
        {
            reader = await JazminReader.OpenAsync(source.Path, source.Options, context.RequestAborted);
        }
        catch (JazminKeyException)
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }
        catch (IOException e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            return Results.NotFound();
        }
        context.Response.RegisterForDispose(reader);
        var file = reader.Files.FirstOrDefault(f => f.Path == path);
        if (file is null) return Results.NotFound(); // absent, or not visible with this key: the same answer

        var headers = context.Response.Headers;
        headers.XContentTypeOptions = "nosniff";
        headers.CacheControl = settings.CacheControl;
        if (ActiveType().IsMatch(file.Type))
        {
            var policy = DocumentPolicy.For(reader.Package, settings.Origin);
            headers.ContentSecurityPolicy = settings.Sandbox ? $"{policy}; {DocumentPolicy.Sandbox}" : policy;
        }
        // A seekable stream that decodes one block at a time: ASP.NET serves ranges, HEAD and 304s from it.
        return Results.Stream(reader.OpenFile(path), string.IsNullOrEmpty(file.Type) ? "application/octet-stream" : file.Type,
            enableRangeProcessing: true, entityTag: new EntityTagHeaderValue($"\"{file.Sha256}\""));
    }

    [GeneratedRegex(@"^(text/html|application/xhtml\+xml|image/svg\+xml|text/xml|application/xml)\b", RegexOptions.IgnoreCase)]
    private static partial Regex ActiveType();
}

/// <summary>The security policy the JAZMIN viewer gives a package's document (js/viewer/viewer.js, policy()).</summary>
internal static class DocumentPolicy
{
    public const string Sandbox = "sandbox allow-scripts allow-downloads allow-popups";

    /// <summary>
    /// The package's allowed origins (and <paramref name="self"/>, where its files are served from) are its only network
    /// access: scripts, styles, images, fonts, audio and video, and requests.
    /// </summary>
    public static string For(JazminPackage? package, string? self = null)
    {
        var origins = string.Join(' ', (self is null ? [] : new[] { self }).Concat(package?.AllowedOrigins ?? []));
        var extra = origins.Length > 0 ? $" {origins}" : "";
        var wasm = package?.AllowWasm == true ? " 'wasm-unsafe-eval'" : "";
        return string.Join("; ",
            "default-src 'none'",
            $"script-src 'unsafe-inline' blob:{wasm}{extra}",
            $"style-src 'unsafe-inline' blob:{extra}",
            $"img-src blob: data:{extra}",
            $"font-src blob: data:{extra}",
            $"media-src blob: data:{extra}",
            "object-src blob:", "frame-src blob:", "worker-src blob:",
            $"connect-src blob: data:{extra}");
    }
}
