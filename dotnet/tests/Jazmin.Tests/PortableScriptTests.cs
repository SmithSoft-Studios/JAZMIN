using System.Text;
using Xunit;

namespace Jazmin.Tests;

/// <summary>
/// A .jzm as a script (JazminFile.PortableScript), for pages opened from disk, which the browser reader's openScript()
/// opens: the same text as the JavaScript library's portableScript (js/test/portable.test.js has the same cases).
/// </summary>
public class PortableScriptTests
{
    private const string Tail = " }; })(globalThis.JazminScripts = globalThis.JazminScripts || {}, typeof document === \"undefined\" ? null : document.currentScript);\n";

    private static readonly byte[] Small = "JZM1"u8.ToArray().Concat(Enumerable.Range(0, 60).Select(i => (byte)i)).ToArray();

    [Fact]
    public void TheFileAsBase64InAScript_TheSameTextAsTheJavaScriptLibrary()
    {
        const string quoted = @"""a \""b\""\\c\né\u001f.jzm""";
        Assert.Equal("/* A JAZMIN file as a script, for pages opened from disk: JazminBrowser.openScript() opens it. */\n"
            + "(function (scripts, script) { scripts[script ? script.src : " + quoted + "] = { name: " + quoted
            + ", data: \"SlpNMQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ow==\"" + Tail,
            JazminFile.PortableScript(Small, "a \"b\"\\c\né\u001f.jzm"));
        Assert.Contains("name: \"file.jzm\"", JazminFile.PortableScript(Small));
        // Names are quoted as JavaScript's JSON.stringify quotes them.
        Assert.Contains(@"name: ""\ud800\b\t\u0000 <&'>""", JazminFile.PortableScript(Small, "\ud800\b\t\0 <&'>"));
        Assert.Throws<JazminValidationException>(() => JazminFile.PortableScript(Encoding.UTF8.GetBytes("not a JAZMIN file at all, only some text that is long enough to check")));
    }

    [Fact]
    public void FromAPath_TheFileAsItIs_StillEncrypted()
    {
        var path = Path.Combine(Fuzzing.Fixtures, "js-key.jzm");
        var script = JazminFile.PortableScript(path);
        Assert.Contains("name: \"js-key.jzm\"", script);
        Assert.Equal(script, JazminFile.PortableScript(File.ReadAllBytes(path), "js-key.jzm"));
        var start = script.IndexOf("data: \"", StringComparison.Ordinal) + "data: \"".Length;
        Assert.Equal(File.ReadAllBytes(path), Convert.FromBase64String(script[start..script.IndexOf('"', start)]));
    }
}
