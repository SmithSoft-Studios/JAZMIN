using System.Buffers.Binary;
using Jazmin.Query;
using Xunit;

namespace Jazmin.Tests;

/// <summary>Fixes from the internal security review (TASKS S-4, docs/SECURITY-REVIEW.md section 7).</summary>
public class SecurityTests
{
    private static readonly JazminColumn[] Columns = [new("id", JazminType.Int), new("branch", JazminType.String), new("salary", JazminType.Float)];

    private static readonly object?[][] Rows = Enumerable.Range(0, 10).Select(i => new object?[] { (long)i, i < 5 ? "A" : "B", 1000.0 + i }).ToArray();

    [Fact]
    public void PasswordFile_AskingForTooFewOrTooManyIterations_IsRefusedBeforeDerivingTheKey()
    {
        var file = TestData.Write(Columns, Rows, new JazminWriteOptions { Password = "pw", KdfIterations = 1000 });
        foreach (var iterations in new uint[] { 0, 999, 10_000_001, uint.MaxValue })
        {
            var changed = (byte[])file.Clone();
            BinaryPrimitives.WriteUInt32LittleEndian(changed.AsSpan(56), iterations); // preamble: kdf_iterations
            var error = Assert.Throws<JazminFormatException>(() => JazminReader.Open(changed, new JazminReadOptions { Password = "pw" }));
            Assert.Contains("password iterations", error.Message);
        }
        Assert.Throws<JazminValidationException>(() => TestData.Write(Columns, Rows, new JazminWriteOptions { Password = "pw", KdfIterations = 10_000_001 }));
    }

    [Fact]
    public void SignatureAndKeySlotSections_MustBeStoredUncompressedAndUnencrypted()
    {
        var owner = JazminKey.Generate();
        var file = TestData.Write(Columns, Rows, new JazminWriteOptions { Key = owner, Access = new JazminAccessOptions { PartitionBy = "branch" } });
        byte[] Changed(int trailerField)
        {
            var copy = (byte[])file.Clone();
            copy[(int)BinaryPrimitives.ReadUInt64LittleEndian(copy.AsSpan(copy.Length - 44 + trailerField))] = 2; // codec: brotli
            return copy;
        }
        var error = Assert.Throws<JazminFormatException>(() => JazminReader.Open(Changed(24), new JazminReadOptions { Key = owner })); // signature
        Assert.Contains("'signature' must be stored as is", error.Message);
        Assert.Throws<JazminFormatException>(() => JazminReader.Open(Changed(12), new JazminReadOptions { Key = owner })); // the key-slot list is signed
    }

    [Fact]
    public void HiddenColumnPlaceholders_CannotBeNamedInFilters()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        var file = TestData.Write(Columns, Rows, new JazminWriteOptions
        {
            Key = owner,
            Access = new JazminAccessOptions
            {
                PartitionBy = "branch",
                ColumnGroups = new() { ["pii"] = ["salary"] },
                Grants = [new JazminGrant(bob) { Rows = ["A"], Columns = ["*"] }],
            },
        });
        using var reader = JazminReader.Open(file, new JazminReadOptions { AccessKey = bob });
        var error = Assert.Throws<JazminValidationException>(() => reader.Find(JazminFilter.Gt("\u00002", 0.0)).ToList()); // position 2: salary
        Assert.Contains("unknown column", error.Message);
    }

    [Fact]
    public void Rewrite_KeepsTheFilePermissions()
    {
        if (OperatingSystem.IsWindows()) return; // POSIX permissions
        var path = Path.Combine(Directory.CreateTempSubdirectory("jazmin-security-").FullName, "p.jzm");
        File.WriteAllBytes(path, TestData.Write(Columns, Rows));
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        JazminFile.Update(path, new JazminUpdate { Insert = [new Dictionary<string, object?> { ["id"] = 10L, ["branch"] = "C", ["salary"] = 1.0 }] });
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
    }
}
