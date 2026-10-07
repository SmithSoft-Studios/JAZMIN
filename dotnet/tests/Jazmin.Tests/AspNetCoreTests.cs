using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using Jazmin.AspNetCore;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// MapJazminFiles (Jazmin.AspNetCore, TASKS F-3) on a real server: embedded files per key, byte ranges, ETags, HEAD,
/// the document policy and sandbox on pages and SVG, and 403/404 for keys and files that don't fit.
/// </summary>
public sealed class AspNetCoreTests : IAsyncLifetime
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-aspnetcore-").FullName;
    private readonly JazminKey _key = JazminKey.Generate();
    private readonly byte[] _big = Enumerable.Range(0, 600_000).Select(i => (byte)((i * 31 + 7) & 255)).ToArray();
    private WebApplication? _app;
    private HttpClient _http = new();

    private string FilePath => Path.Combine(_dir, "docs.jzm");

    public async Task InitializeAsync()
    {
        using (var writer = JazminWriter.Create(FilePath, [new JazminColumn("n", JazminType.Int)], new JazminWriteOptions
               {
                   Key = _key,
                   Files =
                   [
                       new JazminFileInput("index.html", Encoding.UTF8.GetBytes("<!doctype html><p>Page</p>")),
                       new JazminFileInput("media/big file.bin", _big),
                       new JazminFileInput("img/logo.svg", Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")),
                   ],
                   Package = new JazminPackage { Entry = "index.html", AllowedOrigins = ["https://fonts.example.com"] },
               }))
            writer.WriteValues([1L]);

        var keys = JsonNode.Parse(File.ReadAllText(Path.Combine(Fuzzing.Fixtures, "keys.json")))!;
        var bob = JazminAccessKey.Parse((string)keys["bob"]!);
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        _app = builder.Build();
        _app.MapJazminFiles("/docs/{id}", context => ValueTask.FromResult<JazminFileSource?>(context.Request.RouteValues["id"] switch
        {
            "own" => new JazminFileSource(FilePath, new JazminReadOptions { Key = _key }),
            "bob" => new JazminFileSource(Path.Combine(Fuzzing.Fixtures, "dotnet-files-access.jzm"), new JazminReadOptions { AccessKey = bob, CheckClockRollback = false }),
            "wrong" => new JazminFileSource(FilePath, new JazminReadOptions { Key = JazminKey.Generate() }),
            "gone" => new JazminFileSource(Path.Combine(_dir, "missing.jzm"), new JazminReadOptions { Key = _key }),
            _ => null,
        }));
        _app.MapJazminFiles("/open/{id}", _ => ValueTask.FromResult<JazminFileSource?>(new JazminFileSource(FilePath, new JazminReadOptions { Key = _key })),
            new JazminFilesOptions { Sandbox = false, Origin = "https://files.example.com" });
        await _app.StartAsync();
        var address = _app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
        _http = new HttpClient { BaseAddress = new Uri(address) };
    }

    public async Task DisposeAsync()
    {
        _http.Dispose();
        if (_app is not null) await _app.DisposeAsync();
        Directory.Delete(_dir, recursive: true);
    }

    private Task<HttpResponseMessage> Get(string path, Action<HttpRequestMessage>? change = null, HttpMethod? method = null)
    {
        var request = new HttpRequestMessage(method ?? HttpMethod.Get, path);
        change?.Invoke(request);
        return _http.SendAsync(request);
    }

    [Fact]
    public async Task Files_AreServedWhole_WithTheirType_AndTheirSha256AsETag()
    {
        var response = await Get("/docs/own/media/big%20file.bin");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(_big, await response.Content.ReadAsByteArrayAsync());
        Assert.Equal("application/octet-stream", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("bytes", string.Join(",", response.Headers.AcceptRanges));
        Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.True(response.Headers.CacheControl is { Private: true, NoCache: true });
        Assert.False(response.Headers.Contains("Content-Security-Policy"));
        using var reader = JazminReader.Open(FilePath, new JazminReadOptions { Key = _key });
        var sha = reader.Files.Single(f => f.Path == "media/big file.bin").Sha256;
        Assert.Equal($"\"{sha}\"", response.Headers.ETag?.Tag);

        var again = await Get("/docs/own/media/big%20file.bin", r => r.Headers.IfNoneMatch.Add(new EntityTagHeaderValue($"\"{sha}\"")));
        Assert.Equal(HttpStatusCode.NotModified, again.StatusCode);
        var head = await Get("/docs/own/media/big%20file.bin", method: HttpMethod.Head);
        Assert.Equal(HttpStatusCode.OK, head.StatusCode);
        Assert.Equal(600_000, head.Content.Headers.ContentLength);
        Assert.Empty(await head.Content.ReadAsByteArrayAsync());
    }

    [Theory]
    [InlineData(0, 99)]
    [InlineData(262_100, 262_299)] // across a block boundary (blocks are 256 KiB)
    [InlineData(599_900, 599_999)]
    public async Task ByteRanges_AreServedFromTheirBlocks(long from, long to)
    {
        var response = await Get("/docs/own/media/big%20file.bin", r => r.Headers.Range = new RangeHeaderValue(from, to));
        Assert.Equal(HttpStatusCode.PartialContent, response.StatusCode);
        Assert.Equal($"bytes {from}-{to}/600000", response.Content.Headers.ContentRange?.ToString());
        Assert.Equal(_big[(int)from..(int)(to + 1)], await response.Content.ReadAsByteArrayAsync());

        var beyond = await Get("/docs/own/media/big%20file.bin", r => r.Headers.Range = new RangeHeaderValue(600_000, null));
        Assert.Equal(HttpStatusCode.RequestedRangeNotSatisfiable, beyond.StatusCode);
    }

    [Fact]
    public async Task PagesAndSvg_GetTheDocumentPolicy_Sandboxed_UnlessTurnedOff()
    {
        foreach (var path in new[] { "/docs/own/index.html", "/docs/own/img/logo.svg" })
        {
            var policy = (await Get(path)).Headers.GetValues("Content-Security-Policy").Single();
            Assert.Contains("default-src 'none'", policy);
            Assert.Contains("font-src blob: data: 'self' https://fonts.example.com", policy);
            Assert.EndsWith("; sandbox allow-scripts allow-downloads allow-popups", policy);
        }
        var open = (await Get("/open/x/index.html")).Headers.GetValues("Content-Security-Policy").Single();
        Assert.Contains("script-src 'unsafe-inline' blob: https://files.example.com https://fonts.example.com", open);
        Assert.DoesNotContain("sandbox", open);
    }

    [Fact]
    public async Task AKey_IsServedOnlyWhatItCanSee_AndKeysOrFilesThatDoNotFit_AreRefused()
    {
        Assert.Equal(HttpStatusCode.OK, (await Get("/docs/bob/docs/za.bin")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Get("/docs/bob/docs/shared.bin")).StatusCode); // another key's file
        Assert.Equal(HttpStatusCode.NotFound, (await Get("/docs/own/nope.txt")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Get("/docs/unknown/index.html")).StatusCode); // the resolver said no
        Assert.Equal(HttpStatusCode.NotFound, (await Get("/docs/gone/index.html")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Get("/docs/wrong/index.html")).StatusCode);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, (await Get("/docs/own/index.html", method: HttpMethod.Post)).StatusCode);
    }

    [Fact]
    public void DocumentPolicy_IsTheViewers()
    {
        // The strings js/src/server.js documentPolicy() gives for these settings (server.test.js checks that against the
        // viewer's own policy()).
        Assert.Equal(
            "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob: data:; "
            + "media-src blob: data:; object-src blob:; frame-src blob:; worker-src blob:; connect-src blob: data:",
            DocumentPolicy.For(null));
        Assert.Equal(
            "default-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval' https://api.example.com; style-src 'unsafe-inline' blob: https://api.example.com; "
            + "img-src blob: data: https://api.example.com; font-src blob: data: https://api.example.com; media-src blob: data: https://api.example.com; "
            + "object-src blob:; frame-src blob:; worker-src blob:; connect-src blob: data: https://api.example.com",
            DocumentPolicy.For(new JazminPackage { AllowedOrigins = ["https://api.example.com"], AllowWasm = true }));
    }
}
