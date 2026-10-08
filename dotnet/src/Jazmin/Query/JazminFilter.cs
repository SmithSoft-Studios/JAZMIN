using System.Text.Json;

namespace Jazmin.Query;

/// <summary>
/// A filter in the JAZMIN filter language (spec section 9). Build one with the static
/// helpers, combine with <c>&amp;</c>, <c>|</c>, <c>!</c>, or parse the GraphQL-style JSON form:
/// <code>{ "country": "ZA", "age": { "gte": 18 }, "or": [ ... ] }</code>
/// </summary>
public abstract class JazminFilter
{
    private protected JazminFilter() { }

    public static JazminFilter Eq(string column, object? value) => new Condition(column, "eq", value);
    public static JazminFilter Ne(string column, object? value) => new Condition(column, "ne", value);
    public static JazminFilter Gt(string column, object value) => new Condition(column, "gt", value);
    public static JazminFilter Gte(string column, object value) => new Condition(column, "gte", value);
    public static JazminFilter Lt(string column, object value) => new Condition(column, "lt", value);
    public static JazminFilter Lte(string column, object value) => new Condition(column, "lte", value);
    public static JazminFilter In(string column, params object?[] values) => new Condition(column, "in", values);
    public static JazminFilter Contains(string column, string text) => new Condition(column, "contains", text);
    public static JazminFilter IContains(string column, string text) => new Condition(column, "icontains", text);
    public static JazminFilter StartsWith(string column, string text) => new Condition(column, "startsWith", text);
    public static JazminFilter IsNull(string column, bool isNull = true) => new Condition(column, "isNull", isNull);

    /// <summary>
    /// A list column (spec 5.4) with at least one item that matches <paramref name="items"/>: a filter of the items'
    /// fields, or for items that are not objects a condition on the item itself (<see cref="Itself"/>). Conditions in one
    /// filter apply to the same item. A null list matches nothing; an empty one has no item that matches.
    /// </summary>
    public static JazminFilter Any(string column, JazminFilter items) => new Condition(column, "any", items);

    /// <summary>A list column whose items all match <paramref name="items"/> (see <see cref="Any"/>): an empty list does; a null one does not.</summary>
    public static JazminFilter All(string column, JazminFilter items) => new Condition(column, "all", items);

    /// <summary>An object column (spec 5.4) whose fields match <paramref name="fields"/>: a null object matches nothing.</summary>
    public static JazminFilter Match(string column, JazminFilter fields) => new Condition(column, "match", fields);

    /// <summary>In a condition on list items that are not objects: the item itself, as in <c>Any("tags", Eq(JazminFilter.Itself, "vip"))</c>.</summary>
    public const string Itself = "";
    public static JazminFilter And(params JazminFilter[] items) => new Group("and", items);
    public static JazminFilter Or(params JazminFilter[] items) => new Group("or", items);
    public static JazminFilter Not(JazminFilter item) => new Negation(item);

    public static JazminFilter operator &(JazminFilter a, JazminFilter b) => And(a, b);
    public static JazminFilter operator |(JazminFilter a, JazminFilter b) => Or(a, b);
    public static JazminFilter operator !(JazminFilter a) => Not(a);

    /// <summary>Parses the JSON ("where" object) form, identical to the JavaScript library.</summary>
    public static JazminFilter Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return FromJson(doc.RootElement);
    }

    public static JazminFilter FromJson(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) throw Invalid("expected an object");
        var items = new List<JazminFilter>();
        foreach (var property in element.EnumerateObject())
        {
            switch (property.Name)
            {
                case "and":
                case "or":
                    if (property.Value.ValueKind != JsonValueKind.Array) throw Invalid($"'{property.Name}' must be an array");
                    items.Add(new Group(property.Name, property.Value.EnumerateArray().Select(FromJson).ToArray()));
                    break;
                case "not":
                    items.Add(new Negation(FromJson(property.Value)));
                    break;
                default:
                    items.AddRange(Conditions(property.Name, property.Value));
                    break;
            }
        }
        return items.Count == 1 ? items[0] : new Group("and", items.ToArray());
    }

    private static IEnumerable<JazminFilter> Conditions(string column, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            yield return new Condition(column, "eq", Operand(value)); // shorthand: { "name": "x" }
            yield break;
        }
        var any = false;
        foreach (var op in value.EnumerateObject())
        {
            any = true;
            // any / all / match hold a filter of a list's items or an object's fields: read once the column's definition is known.
            yield return new Condition(column, op.Name, op.Name is "any" or "all" or "match" ? op.Value.Clone() : Operand(op.Value));
        }
        if (!any) throw Invalid($"empty condition for '{column}'");
    }

    /// <summary>The condition (JSON) on a list item that is not an object: the item itself is <see cref="Itself"/>.</summary>
    internal static JazminFilter ItemConditions(JsonElement value)
    {
        var items = Conditions(Itself, value).ToArray();
        return items.Length == 1 ? items[0] : new Group("and", items);
    }

    private static object? Operand(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Null => null,
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.String => e.GetString(),
        JsonValueKind.Number => e.TryGetInt64(out var l) ? l : (object)e.GetDouble(), // whole numbers stay exact (not a double)
        JsonValueKind.Array => e.EnumerateArray().Select(Operand).ToArray(),
        _ => throw Invalid("unsupported operand"),
    };

    internal static JazminValidationException Invalid(string message) => new($"Invalid filter: {message}");

    internal sealed class Condition(string column, string op, object? value) : JazminFilter
    {
        public string Column { get; } = column;
        public string Op { get; } = op;
        public object? Value { get; } = value;
    }

    internal sealed class Group(string kind, JazminFilter[] items) : JazminFilter
    {
        public string Kind { get; } = kind;
        public JazminFilter[] Items { get; } = items;
    }

    internal sealed class Negation(JazminFilter item) : JazminFilter
    {
        public JazminFilter Item { get; } = item;
    }
}
