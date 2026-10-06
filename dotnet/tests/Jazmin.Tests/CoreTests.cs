using System.Security.Cryptography;
using System.Text;
using Jazmin.Format;
using Xunit;

namespace Jazmin.Tests;

public class BinaryTests
{
    [Theory]
    [InlineData(0L)]
    [InlineData(-1L)]
    [InlineData(1L)]
    [InlineData(-64L)]
    [InlineData(long.MaxValue)]
    [InlineData(long.MinValue)]
    public void VarInt_RoundTrips(long value)
    {
        var w = new ByteWriter();
        w.VarInt(value);
        Assert.Equal(value, new ByteReader(w.ToArray()).VarInt());
    }

    [Fact]
    public void SmallNegative_EncodesInOneByte()
    {
        var w = new ByteWriter();
        w.VarInt(-1);
        Assert.Equal(new byte[] { 1 }, w.ToArray());
    }

    [Fact]
    public void Crc32_MatchesStandardCheckValue() =>
        Assert.Equal(0xcbf43926u, Crc32.Compute(Encoding.ASCII.GetBytes("123456789")));

    [Fact]
    public void Crc32_SlicingBy8_MatchesBytewiseOnAllLengthsAndAlignments()
    {
        var data = new byte[1100];
        new Random(7).NextBytes(data);
        for (var start = 0; start < 9; start++)
            for (var length = 0; length < 1000; length += 13)
                Assert.Equal(Crc32.ComputeBytewise(data.AsSpan(start, length)), Crc32.Compute(data.AsSpan(start, length)));
    }

    [Fact]
    public void ReadingPastEnd_Throws() =>
        Assert.Throws<JazminFormatException>(() => new ByteReader(new byte[] { 0x80 }).VarUInt());

    [Fact]
    public void Hkdf_MatchesRfc5869TestCase1()
    {
        var ikm = Enumerable.Repeat((byte)0x0b, 22).ToArray();
        var salt = Convert.FromHexString("000102030405060708090a0b0c");
        var okm = new byte[32];
        HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, okm, salt, Convert.FromHexString("f0f1f2f3f4f5f6f7f8f9"));
        Assert.Equal("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf", Convert.ToHexString(okm).ToLowerInvariant());
    }
}

public class KeyTests
{
    [Fact]
    public void KeyText_RoundTrips()
    {
        var key = JazminKey.Generate();
        var text = key.ToString();
        Assert.Matches("^jzk1-[A-Za-z0-9_-]{48}$", text);
        Assert.Equal(key.ToBytes(), JazminKey.Parse(text).ToBytes());
    }

    [Fact]
    public void Export_GivesTheKeyText_AsToStringDoesUntil2()
    {
        var owner = JazminKey.Generate();
        var bob = owner.CreateAccessKey();
        Assert.Equal(owner.ToString(), owner.Export());
        Assert.Equal(owner.ToBytes(), JazminKey.Parse(owner.Export()).ToBytes());
        Assert.StartsWith("jza1-", bob.Export());
        Assert.Equal(bob.ToString(), bob.Export());
        Assert.Equal(bob.Id, JazminAccessKey.Parse(bob.Export()).Id);
    }

    [Fact]
    public void MistypedKey_IsRejectedByChecksum()
    {
        var text = JazminKey.Generate().ToString();
        var chars = text.ToCharArray();
        chars[^10] = chars[^10] == 'A' ? 'B' : 'A';
        Assert.Throws<JazminKeyException>(() => JazminKey.Parse(new string(chars)));
    }

    [Fact]
    public void Key_MustBe32Bytes() => Assert.Throws<JazminKeyException>(() => new JazminKey(new byte[16]));
}
