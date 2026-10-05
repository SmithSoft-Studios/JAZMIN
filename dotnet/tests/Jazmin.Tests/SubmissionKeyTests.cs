using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// Submission keys (spec 7.8, issue #13): the key of the files an access key's holder sends back to the owner. The owner
/// derives it from its own key and the access key's id; the writer seals it into that key's slot of the shared file, so
/// only someone who opens the shared file with that access key has it. Mirrors js/test/submission-key.test.js.
/// </summary>
public sealed class SubmissionKeyTests
{
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

    private static readonly JazminColumn[] Columns = [new("id", JazminType.Int), new("person", JazminType.String)];

    private static byte[] Shared(JazminKey owner, params JazminGrant[] grants)
    {
        var stream = new MemoryStream();
        using (var writer = new JazminWriter(stream, Columns, new JazminWriteOptions { Key = owner, Access = new JazminAccessOptions { PartitionBy = "person", Grants = [.. grants] } }, leaveOpen: true))
        {
            writer.WriteRow(new Dictionary<string, object?> { ["id"] = 1L, ["person"] = "P1" });
            writer.WriteRow(new Dictionary<string, object?> { ["id"] = 2L, ["person"] = "P2" });
        }
        return stream.ToArray();
    }

    [Fact]
    public void The_submission_key_is_HKDF_of_the_owner_key_labelled_with_the_access_key_id()
    {
        var owner = new JazminKey(Enumerable.Range(0, 32).Select(i => (byte)i).ToArray());
        var key = owner.SubmissionKey("0001020304050607");
        Assert.Equal("457ac056dd344efb467cdc8a574b1469c328daafd2f09fe14782cd2818ecf29e", Convert.ToHexString(key.Bytes).ToLowerInvariant()); // the RFC's test vector
        Assert.Equal(HKDF.DeriveKey(HashAlgorithmName.SHA256, owner.Bytes.ToArray(), 32, [], Encoding.UTF8.GetBytes("JAZMIN/1/submission/0001020304050607")), key.Bytes.ToArray());
        var bob = owner.CreateAccessKey();
        Assert.Equal(owner.SubmissionKey(bob.Id).ToString(), owner.SubmissionKey(bob).ToString());
        Assert.Throws<JazminValidationException>(() => owner.SubmissionKey("not-an-id"));
    }

    [Fact]
    public void Only_a_key_that_opened_the_shared_file_has_its_submission_key_and_the_owner_derives_the_same()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var sally = owner.CreateAccessKey();
        var carol = owner.CreateAccessKey();
        var bytes = Shared(owner,
            new JazminGrant(bob) { Rows = ["P1"] }, new JazminGrant(sally) { Rows = ["P2"] }, new JazminGrant(carol) { Rows = ["P2"], Mode = JazminGrantMode.Online });
        using (var bobs = JazminReader.Open(bytes, new JazminReadOptions { AccessKey = bob }))
            Assert.Equal(owner.SubmissionKey(bob).ToString(), bobs.SubmissionKey!.ToString());
        using (var sallys = JazminReader.Open(bytes, new JazminReadOptions { AccessKey = sally }))
            Assert.Equal(owner.SubmissionKey(sally).ToString(), sallys.SubmissionKey!.ToString());
        using (var owners = JazminReader.Open(bytes, new JazminReadOptions { Key = owner }))
            Assert.Null(owners.SubmissionKey); // the owner derives anyone's
        Assert.Throws<JazminUnlockRequiredException>(() => JazminReader.Open(bytes, new JazminReadOptions { AccessKey = carol }).Dispose()); // online: needs the token first

        // A file sent back with it opens for the owner only with that holder's key.
        var sent = new MemoryStream();
        using (var writer = new JazminWriter(sent, Columns, new JazminWriteOptions { Key = owner.SubmissionKey(bob) }, leaveOpen: true))
            writer.WriteRow(new Dictionary<string, object?> { ["id"] = 3L, ["person"] = "P1" });
        using (var received = JazminReader.Open(sent.ToArray(), new JazminReadOptions { Key = owner.SubmissionKey(bob.Id) }))
            Assert.Equal(3L, received.Rows().Single()["id"]);
        Assert.ThrowsAny<JazminException>(() => JazminReader.Open(sent.ToArray(), new JazminReadOptions { Key = owner.SubmissionKey(sally) }).Dispose());
        Assert.ThrowsAny<JazminException>(() => JazminReader.Open(bytes, new JazminReadOptions { Key = owner.SubmissionKey(bob) }).Dispose());
    }

    [Fact]
    public void Reads_the_submission_key_the_JavaScript_writer_sealed_and_none_in_older_files()
    {
        var owner = JazminKey.Parse((string)Keys["key"]!);
        var bob = JazminAccessKey.Parse((string)Keys["bob"]!);
        using (var reader = JazminReader.Open(Path.Combine(Fixtures, "js-access.jzm"), new JazminReadOptions { AccessKey = bob }))
            Assert.Equal(owner.SubmissionKey(bob).ToString(), reader.SubmissionKey!.ToString());
        using (var older = JazminReader.Open(Path.Combine(Fixtures, "js-files-access.jzm"), new JazminReadOptions { AccessKey = bob }))
            Assert.Null(older.SubmissionKey); // written before submission keys existed
    }
}
