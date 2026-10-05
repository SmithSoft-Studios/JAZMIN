using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Outbox keys (spec 7.8, issue #13): an access key holder writes files for the owner - records captured offline and
/// sent later - locked with a key derived from their access key. The owner derives the same key from the shared file's
/// grant list; the key opens nothing in the shared file. Mirrors js/test/outbox-key.test.js.
/// </summary>
public sealed class OutboxKeyTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("jazmin-outbox-").FullName;

    public void Dispose() => Directory.Delete(_dir, true);

    private static readonly string Fixtures = FindFixtures();
    private static readonly JsonObject Keys = JsonNode.Parse(File.ReadAllText(Path.Combine(Fixtures, "keys.json")))!.AsObject();

    private static string FindFixtures()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "spec", "fixtures");
            if (File.Exists(Path.Combine(candidate, "keys.json"))) return candidate;
        }
        throw new DirectoryNotFoundException("spec/fixtures not found");
    }

    [Fact]
    public void The_outbox_key_is_HKDF_of_the_access_key_secret_with_the_outbox_label()
    {
        var secret = Enumerable.Range(0, 32).Select(i => (byte)i).ToArray();
        var key = new JazminAccessKey(secret, new byte[8]).OutboxKey();
        Assert.Equal("8e729d9585b59bce5cd951fb3b5f4f81df22fbbb3088e382bd2b490c98309596", Convert.ToHexString(key.Bytes).ToLowerInvariant()); // the RFC's test vector
        Assert.Equal(HKDF.DeriveKey(HashAlgorithmName.SHA256, secret, 32, [], Encoding.UTF8.GetBytes("JAZMIN/1/outbox")), key.Bytes.ToArray());
        Assert.Equal((string)Keys["bobOutbox"]!, JazminAccessKey.Parse((string)Keys["bob"]!).OutboxKey().ToString()); // the same in JS and the browser
    }

    [Fact]
    public void The_owner_finds_an_access_key_in_the_grant_list_and_opens_that_holders_outbox_files()
    {
        var shared = Path.Combine(Fixtures, "dotnet-access.jzm");
        var owner = JazminKey.Parse((string)Keys["key"]!);
        var bob = JazminAccessKey.Parse((string)Keys["bob"]!);
        Assert.Equal(bob.ToString(), JazminFile.AccessKeyOf(shared, owner, bob.Id).ToString());
        Assert.Contains("has no grant", Assert.Throws<JazminValidationException>(() => JazminFile.AccessKeyOf(shared, owner, "0123456789abcdef")).Message);

        // Bob writes an outbox batch; the owner opens it with the key derived from the grant list.
        var batch = Path.Combine(_dir, "batch.jzm");
        using (var writer = JazminWriter.Create(batch, [new JazminColumn("id", JazminType.Int), new JazminColumn("note", JazminType.String)], new JazminWriteOptions { Key = bob.OutboxKey() }))
            writer.WriteRow(new Dictionary<string, object?> { ["id"] = 1L, ["note"] = "captured offline" });
        using (var reader = JazminReader.Open(batch, new JazminReadOptions { Key = JazminFile.AccessKeyOf(shared, owner, bob.Id).OutboxKey() }))
            Assert.Equal("captured offline", reader.Rows().Single()["note"]);
        Assert.ThrowsAny<JazminException>(() => JazminReader.Open(batch, new JazminReadOptions { Key = JazminAccessKey.Parse((string)Keys["sally"]!).OutboxKey() }).Dispose());
        Assert.ThrowsAny<JazminException>(() => JazminReader.Open(shared, new JazminReadOptions { Key = bob.OutboxKey() }).Dispose());
    }
}
