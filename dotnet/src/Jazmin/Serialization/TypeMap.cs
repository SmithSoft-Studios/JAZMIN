using System.ComponentModel;
using System.Collections.Concurrent;
using System.Globalization;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Jazmin.Format;

namespace Jazmin.Serialization;

/// <summary>
/// Maps a CLR type to columns and converts instances to/from rows. Honours [JazminProperty], [JazminIgnore],
/// [JazminIndex], [JazminConverter], [Description], [DefaultValue], System.Text.Json's [JsonPropertyName] / [JsonIgnore] /
/// [JsonDerivedType] / [JsonPolymorphic], and the settings' naming strategy, converters, DefaultValueHandling and
/// PreserveReferencesHandling.
/// </summary>
internal sealed class TypeMap
{
    private static readonly ConcurrentDictionary<Type, TypeMap> Plain = new();

    // Settings that change the mapping get their own maps, kept as long as the settings instance lives.
    private static readonly ConditionalWeakTable<JazminSerializerSettings, ConcurrentDictionary<Type, TypeMap>> BySettings = new();

    private const string IdColumn = "$id";
    private const string RefColumn = "$ref";

    private readonly Type _type;
    private readonly Member[] _members;
    private readonly ConstructorInfo? _defaultCtor;
    private readonly ConstructorInfo? _paramCtor;
    private readonly bool _ignoreDefaults; // DefaultValueHandling.Ignore: default values are stored as null
    private readonly bool _populate; // DefaultValueHandling.Populate: nulls are read as default values
    private readonly bool _preserveReferences; // $id / $ref columns first
    private readonly int _first; // position of the first member column (after $id, $ref and the discriminator)
    private readonly string? _discriminator; // polymorphic base type: the discriminator column
    private readonly Derived[]? _derived; // polymorphic base type: its derived types

    private sealed record Member(PropertyInfo Property, JazminColumn Column, JazminConverter? Converter, object? DefaultValue)
    {
        // Compiled accessors: much faster than PropertyInfo.GetValue/SetValue on large collections.
        public Func<object, object?> Get { get; } = CompileGetter(Property);

        public Action<object, object?>? Set { get; } = Property.CanWrite && Property.SetMethod!.IsPublic ? CompileSetter(Property) : null;
    }

    /// <summary>A derived type of a polymorphic base: its discriminator, its own map, and where its members go in the base's columns.</summary>
    private sealed record Derived(Type Type, string Discriminator, TypeMap Map, int[] Positions);

    private static Func<object, object?> CompileGetter(PropertyInfo p)
    {
        var instance = Expression.Parameter(typeof(object));
        var body = Expression.Convert(Expression.Property(Expression.Convert(instance, p.DeclaringType!), p), typeof(object));
        return Expression.Lambda<Func<object, object?>>(body, instance).Compile();
    }

    private static Action<object, object?> CompileSetter(PropertyInfo p)
    {
        var instance = Expression.Parameter(typeof(object));
        var value = Expression.Parameter(typeof(object));
        var body = Expression.Assign(
            Expression.Property(Expression.Convert(instance, p.DeclaringType!), p),
            Expression.Convert(value, p.PropertyType));
        return Expression.Lambda<Action<object, object?>>(body, instance, value).Compile();
    }

    private TypeMap(Type type, JazminSerializerSettings? settings, bool topLevel = true)
    {
        _type = type;
        var handling = settings?.DefaultValueHandling ?? DefaultValueHandling.Include;
        _ignoreDefaults = handling.HasFlag(DefaultValueHandling.Ignore);
        _populate = handling.HasFlag(DefaultValueHandling.Populate);
        var naming = settings?.NamingStrategy;
        var members = new List<Member>();
        foreach (var p in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!p.CanRead || p.GetIndexParameters().Length > 0) continue;
            if (p.GetCustomAttribute<JazminIgnoreAttribute>() is not null || p.GetCustomAttribute<JsonIgnoreAttribute>() is not null) continue;
            var attr = p.GetCustomAttribute<JazminPropertyAttribute>();
            var name = attr?.Name ?? p.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name ?? naming?.GetColumnName(p.Name) ?? p.Name;
            var underlying = Nullable.GetUnderlyingType(p.PropertyType) ?? p.PropertyType;
            var converter = p.GetCustomAttribute<JazminConverterAttribute>()?.Create()
                ?? settings?.Converters.FirstOrDefault(c => c.CanConvert(underlying))
                ?? underlying.GetCustomAttribute<JazminConverterAttribute>()?.Create();
            if (converter is not null && !converter.CanConvert(underlying))
                throw new JazminValidationException($"{converter.GetType().Name} cannot convert {underlying.Name} (property {p.Name})");
            var (columnType, nullable) = Infer(p.PropertyType);
            var column = new JazminColumn(name, attr?.TypeOverride ?? converter?.ColumnType ?? columnType)
            {
                Nullable = nullable || _ignoreDefaults, // with DefaultValueHandling.Ignore, defaults are stored as null
                Description = attr?.Description ?? p.GetCustomAttribute<DescriptionAttribute>()?.Description,
                Indexes = p.GetCustomAttribute<JazminIndexAttribute>()?.Kinds ?? Array.Empty<JazminIndexKind>(),
            };
            if (column.Type == JazminType.Json && converter is null && attr?.TypeOverride is null
                && (p.GetCustomAttribute<JazminNestedAttribute>()?.Store ?? settings?.NestedColumns ?? false))
            {
                var nested = NestedSchema(p.PropertyType, name, settings);
                if (nested is null && p.GetCustomAttribute<JazminNestedAttribute>()?.Store == true)
                    throw new JazminValidationException($"{type.Name}.{p.Name}: {p.PropertyType.Name} cannot be stored as nested columns (lists, arrays and classes can; dictionaries, object, polymorphic types and types that contain themselves cannot)");
                if (nested is not null)
                    column = new JazminColumn(name, nested.Type) { Nullable = column.Nullable, Description = column.Description, Item = nested.Item, Fields = nested.Fields };
            }
            members.Add(new Member(p, column, converter, DefaultOf(p)));
        }
        if (members.Count == 0) throw new JazminValidationException($"Type {type.Name} has no public readable properties to serialize");
        _members = members.ToArray();

        var columns = new List<JazminColumn>();
        _preserveReferences = settings?.PreserveReferencesHandling == PreserveReferencesHandling.Objects && topLevel;
        if (_preserveReferences)
        {
            columns.Add(new JazminColumn(IdColumn, JazminType.String));
            columns.Add(new JazminColumn(RefColumn, JazminType.String));
        }
        var derivedTypes = topLevel ? type.GetCustomAttributes<JsonDerivedTypeAttribute>(inherit: false).ToList() : [];
        if (derivedTypes.Count > 0)
        {
            // Opt-in polymorphism with a closed list of types ([JsonDerivedType]): a file never names a type to load.
            _discriminator = type.GetCustomAttribute<JsonPolymorphicAttribute>()?.TypeDiscriminatorPropertyName ?? "$type";
            columns.Add(new JazminColumn(_discriminator, JazminType.String));
        }
        _first = columns.Count;
        columns.AddRange(_members.Select(m => m.Column));
        if (derivedTypes.Count > 0)
        {
            var derived = new List<Derived>();
            foreach (var attr in derivedTypes)
            {
                if (!type.IsAssignableFrom(attr.DerivedType)) throw new JazminValidationException($"{attr.DerivedType.Name} does not derive from {type.Name}");
                var map = new TypeMap(attr.DerivedType, settings, topLevel: false);
                var positions = map._members.Select(m =>
                {
                    var at = columns.FindIndex(c => c.Name == m.Column.Name);
                    if (at < 0)
                    {
                        columns.Add(new JazminColumn(m.Column.Name, m.Column.Type) { Nullable = true, Description = m.Column.Description, Indexes = m.Column.Indexes });
                        return columns.Count - 1;
                    }
                    if (columns[at].Type != m.Column.Type)
                        throw new JazminValidationException($"Column '{m.Column.Name}' has different types in the derived types of {type.Name}");
                    return at;
                }).ToArray();
                var discriminator = attr.TypeDiscriminator?.ToString() ?? attr.DerivedType.Name;
                derived.Add(new Derived(attr.DerivedType, discriminator, map, positions));
            }
            _derived = derived.ToArray();
        }
        Columns = columns;
        if (!type.IsAbstract) _defaultCtor = type.GetConstructor(Type.EmptyTypes);
        if (_defaultCtor is null && !type.IsAbstract)
        {
            _paramCtor = type.GetConstructors().OrderByDescending(c => c.GetParameters().Length).FirstOrDefault();
        }
    }

    /// <summary>
    /// A property type as nested columns (spec 5.4): a list or array of items, or a class with fields (its own map's
    /// columns, nested in turn). Null when it cannot be: dictionaries, object, JSON types, polymorphic and abstract types,
    /// and a type that contains itself. Items that cannot be nested are JSON items.
    /// </summary>
    private static JazminColumn? NestedSchema(Type type, string name, JazminSerializerSettings? settings)
    {
        var t = Nullable.GetUnderlyingType(type) ?? type;
        var nullable = !type.IsValueType || Nullable.GetUnderlyingType(type) is not null;
        if (t == typeof(string) || t == typeof(object) || typeof(JsonNode).IsAssignableFrom(t) || t == typeof(JsonElement)) return null;
        if (typeof(System.Collections.IDictionary).IsAssignableFrom(t) || t.GetInterfaces().Concat([t]).Any(i => i.IsGenericType
            && (i.GetGenericTypeDefinition() == typeof(IDictionary<,>) || i.GetGenericTypeDefinition() == typeof(IReadOnlyDictionary<,>)))) return null;
        if (ListElement(t) is { } element)
        {
            var (itemType, itemNullable) = Infer(element);
            var item = itemType != JazminType.Json ? new JazminColumn("item", itemType) { Nullable = itemNullable }
                : NestedSchema(element, "item", settings) ?? new JazminColumn("item", JazminType.Json) { Nullable = itemNullable };
            return new JazminColumn(name, JazminType.List) { Item = item, Nullable = nullable };
        }
        if (t.IsAbstract || t.IsInterface || t.IsPrimitive || t.IsEnum || _building?.Contains(t) == true) return null;
        if (t.GetCustomAttributes<JsonDerivedTypeAttribute>(inherit: false).Any()) return null;
        TypeMap map;
        try
        {
            map = For(t, settings);
        }
        catch (JazminValidationException)
        {
            return null; // no properties to store
        }
        if (map._derived is not null || map._preserveReferences) return null;
        return new JazminColumn(name, JazminType.Object) { Fields = [.. map.Columns], Nullable = nullable };
    }

    /// <summary>The item type of a list type a List&lt;T&gt; or T[] can be read into (arrays, List&lt;T&gt;, their interfaces), or null.</summary>
    private static Type? ListElement(Type t)
    {
        if (t.IsArray) return t.GetArrayRank() == 1 ? t.GetElementType() : null;
        if (!t.IsGenericType) return null;
        var element = t.GetGenericArguments()[0];
        return t.GetGenericArguments().Length == 1 && t.IsAssignableFrom(typeof(List<>).MakeGenericType(element)) ? element : null;
    }

    /// <summary>Nested columns: the stored value of the member for a column (by name, then ignoring case), or null.</summary>
    internal Func<object, object?>? StoredGetter(string column, JazminSerializerSettings? settings)
    {
        var m = Array.Find(_members, x => x.Column.Name == column) ?? Array.Find(_members, x => string.Equals(x.Column.Name, column, StringComparison.OrdinalIgnoreCase));
        return m is null ? null : item => Stored(m, m.Get(item), settings);
    }

    /// <summary>Nested columns: the property of the member for a column (by name, then ignoring case), or null.</summary>
    internal PropertyInfo? MemberProperty(string column) =>
        (Array.Find(_members, x => x.Column.Name == column) ?? Array.Find(_members, x => string.Equals(x.Column.Name, column, StringComparison.OrdinalIgnoreCase)))?.Property;

    /// <summary>Nested columns: whether every member is set straight from its stored value (no converters, defaults or references).</summary>
    internal bool PlainMembers => !_populate && !_ignoreDefaults && !_preserveReferences && _derived is null && _members.All(m => m.Converter is null);

    /// <summary>Nested columns: the type of the member for a column (by name, then ignoring case), or null.</summary>
    internal Type? MemberType(string column) =>
        (Array.Find(_members, x => x.Column.Name == column) ?? Array.Find(_members, x => string.Equals(x.Column.Name, column, StringComparison.OrdinalIgnoreCase)))?.Property.PropertyType;

    [ThreadStatic]
    private static HashSet<Type>? _building; // types whose maps are being built: a type that contains itself stays JSON

    private static TypeMap Build(Type type, JazminSerializerSettings? settings)
    {
        _building ??= [];
        _building.Add(type);
        try
        {
            return new TypeMap(type, settings);
        }
        finally
        {
            _building.Remove(type);
        }
    }

    public static TypeMap For(Type type, JazminSerializerSettings? settings = null) =>
        settings is null || !settings.ShapesContract
            ? Plain.GetOrAdd(type, t => Build(t, null))
            : BySettings.GetValue(settings, _ => new()).GetOrAdd(type, t => Build(t, settings));

    public IReadOnlyList<JazminColumn> Columns { get; }

    /// <summary>Whether writing needs a <see cref="ReferenceTracker"/> and reading a <see cref="ReferenceResolver"/>.</summary>
    public bool PreservesReferences => _preserveReferences;

    /// <summary>
    /// The column of a member, for the LINQ translator. Null when the stored value is not the property's value
    /// (a converter, or defaults stored as null): that part of a predicate is then evaluated in memory only.
    /// </summary>
    public JazminColumn? ColumnFor(MemberInfo member) =>
        _ignoreDefaults ? null : _members.FirstOrDefault(m => m.Property.Name == member.Name && m.Converter is null)?.Column;

    /// <summary>
    /// For LINQ queries that read only some columns: the column a member is read from, when reading sets the member from
    /// that column alone (its setter, or a constructor parameter for types without a parameterless constructor). Null
    /// when its value may come from other members (no setter: computed), or rows may be of several types or refer to
    /// each other: every column is then read.
    /// </summary>
    public string? ColumnRead(MemberInfo member)
    {
        if (_derived is not null || _preserveReferences) return null;
        var m = Array.Find(_members, m => m.Property.Name == member.Name);
        if (m is null) return null;
        if (_defaultCtor is not null) return m.Set is not null ? m.Column.Name : null;
        return _paramCtor is not null && _paramCtor.GetParameters().Any(p => string.Equals(p.Name, m.Property.Name, StringComparison.OrdinalIgnoreCase))
            ? m.Column.Name
            : null;
    }

    /// <summary>The property's default value: its [DefaultValue], or the type's default.</summary>
    private static object? DefaultOf(PropertyInfo p)
    {
        var type = p.PropertyType;
        if (p.GetCustomAttribute<DefaultValueAttribute>() is { } attr)
        {
            var value = attr.Value;
            var target = Nullable.GetUnderlyingType(type) ?? type;
            return value is null || target.IsInstanceOfType(value) ? value
                : target.IsEnum ? Enum.ToObject(target, value)
                : System.Convert.ChangeType(value, target, CultureInfo.InvariantCulture);
        }
        return type.IsValueType && Nullable.GetUnderlyingType(type) is null ? Activator.CreateInstance(type) : null;
    }

    private static (JazminType Type, bool Nullable) Infer(Type type)
    {
        var underlying = Nullable.GetUnderlyingType(type);
        var nullable = underlying is not null || !type.IsValueType;
        var t = underlying ?? type;
        if (t.IsEnum) return (JazminType.String, nullable);
        return (Type.GetTypeCode(t) switch
        {
            TypeCode.Boolean => JazminType.Bool,
            TypeCode.SByte or TypeCode.Byte or TypeCode.Int16 or TypeCode.UInt16 or TypeCode.Int32 or TypeCode.UInt32 or TypeCode.Int64 => JazminType.Int,
            TypeCode.Single or TypeCode.Double => JazminType.Float,
            TypeCode.Decimal => JazminType.Decimal,
            TypeCode.String or TypeCode.Char => JazminType.String,
            TypeCode.DateTime => JazminType.DateTime,
            _ when t == typeof(DateTimeOffset) || t == typeof(DateOnly) => JazminType.DateTime,
            _ when t == typeof(Guid) || t == typeof(TimeSpan) || t == typeof(TimeOnly) => JazminType.String,
            _ when t == typeof(byte[]) => JazminType.Binary,
            _ => JazminType.Json,
        }, nullable);
    }

    /// <summary>Instance -> values in column order (writer accepts these directly).</summary>
    public object?[] ToValues(object item, JazminSerializerSettings? settings, ReferenceTracker? references = null)
    {
        var values = new object?[Columns.Count];
        if (_preserveReferences)
        {
            var tracker = references ?? throw new InvalidOperationException("Preserving references needs a ReferenceTracker");
            if (tracker.TryGetId(item, out var id))
            {
                values[1] = id; // $ref: written before
                return values;
            }
            values[0] = tracker.Add(item);
        }
        if (_derived is not null)
        {
            var type = item.GetType();
            if (type != _type)
            {
                var derived = Array.Find(_derived, d => d.Type == type)
                    ?? throw new JazminValidationException($"{type.Name} is not a [JsonDerivedType] of {_type.Name}");
                values[_first - 1] = derived.Discriminator;
                derived.Map.Fill(item, values, derived.Positions, settings);
                return values;
            }
            if (_type.IsAbstract) throw new JazminValidationException($"Cannot serialize the abstract type {_type.Name}");
        }
        for (var i = 0; i < _members.Length; i++) values[_first + i] = Stored(_members[i], _members[i].Get(item), settings);
        return values;
    }

    /// <summary>Writes this (derived) type's member values into the base type's columns.</summary>
    private void Fill(object item, object?[] values, int[] positions, JazminSerializerSettings? settings)
    {
        for (var i = 0; i < _members.Length; i++) values[positions[i]] = Stored(_members[i], _members[i].Get(item), settings);
    }

    private object? Stored(Member m, object? raw, JazminSerializerSettings? settings)
    {
        if (raw is null) return null;
        if (_ignoreDefaults && Equals(raw, m.DefaultValue)) return null;
        if (m.Converter is { } converter) return converter.ToStored(raw);
        return raw switch
        {
            Enum e => e.ToString(),
            char c => c.ToString(),
            Guid g => g.ToString(),
            TimeSpan ts => ts.ToString("c", CultureInfo.InvariantCulture),
            TimeOnly to => to.ToString("O", CultureInfo.InvariantCulture),
            _ when m.Column.Type == JazminType.Json && raw is not JsonNode => JsonSerializer.SerializeToNode(raw, raw.GetType(), settings?.EffectiveJsonOptions),
            _ => raw,
        };
    }

    /// <summary>
    /// A compiled row -> instance function for one column layout (names, types and order). Built once and reused per
    /// row, and by later readers of files with the same columns: compiling costs far more than a lookup (issue #70).
    /// The settings are an argument, so each call converts with its own.
    /// </summary>
    private sealed record Materializer(IReadOnlyList<JazminColumn> Columns, Func<object?[], JazminSerializerSettings?, object> Create);

    private Materializer? _lastMaterializer; // racy but safe: reference writes are atomic

    private int _compilations;

    /// <summary>Tests: how many row -> instance functions this map has compiled.</summary>
    internal int Compilations => Volatile.Read(ref _compilations);

    /// <summary>Row -> new instance (or, preserving references, an instance read before).</summary>
    public object FromRow(IReadOnlyDictionary<string, object?> row, JazminSerializerSettings? settings, ReferenceResolver? references = null)
    {
        if (!_preserveReferences) return FromRowOnce(row, settings);
        var resolver = references ?? throw new InvalidOperationException("Preserving references needs a ReferenceResolver");
        if (TryGet(row, RefColumn, out var reference) && reference is string refId) return resolver.Get(refId);
        var item = FromRowOnce(row, settings);
        if (TryGet(row, IdColumn, out var id) && id is string idText) resolver.Add(idText, item);
        return item;
    }

    private object FromRowOnce(IReadOnlyDictionary<string, object?> row, JazminSerializerSettings? settings)
    {
        if (_derived is not null && TryGet(row, _discriminator!, out var discriminator) && discriminator is string name)
        {
            var derived = Array.Find(_derived, d => d.Discriminator == name)
                ?? throw new JazminValidationException($"Unknown type '{name}' for {_type.Name}: it is not one of its [JsonDerivedType]s");
            return derived.Map.FromRowOnce(row, settings);
        }
        if (_type.IsAbstract) throw new JazminValidationException($"A row has no type for the abstract type {_type.Name}");
        if (row is JazminRow jazminRow && _defaultCtor is not null)
        {
            var materializer = _lastMaterializer;
            if (materializer is null || !ReferenceEquals(materializer.Columns, jazminRow.Columns))
                _lastMaterializer = materializer = materializer is not null && SameLayout(materializer.Columns, jazminRow.Columns)
                    ? materializer with { Columns = jazminRow.Columns } // another reader, same columns: later rows match by reference
                    : BuildMaterializer(jazminRow.Columns);
            return materializer.Create(jazminRow.RawValues, settings);
        }
        if (_defaultCtor is not null)
        {
            var item = _defaultCtor.Invoke(null);
            foreach (var m in _members)
            {
                if (m.Set is null) continue;
                var found = TryGet(row, m.Column.Name, out var value);
                if (!found && !_populate) continue;
                var converted = value is null ? (_populate ? m.DefaultValue : null) : Read(m, value, m.Property.PropertyType, settings);
                if (converted is null && m.Property.PropertyType.IsValueType && Nullable.GetUnderlyingType(m.Property.PropertyType) is null) continue;
                m.Set(item, converted);
            }
            return item;
        }
        if (_paramCtor is null) throw new JazminValidationException($"Type {_type.Name} has no usable constructor");
        // Records / immutable types: match constructor parameters to properties by name.
        var args = _paramCtor.GetParameters().Select(p =>
        {
            var member = _members.FirstOrDefault(m => string.Equals(m.Property.Name, p.Name, StringComparison.OrdinalIgnoreCase));
            if (member is not null && TryGet(row, member.Column.Name, out var value) && value is not null) return Read(member, value, p.ParameterType, settings);
            if (member is not null && _populate) return member.DefaultValue;
            return p.HasDefaultValue ? p.DefaultValue : null;
        }).ToArray();
        return _paramCtor.Invoke(args);
    }

    /// <summary>A non-null stored value as the member's value.</summary>
    private static object? Read(Member m, object value, Type target, JazminSerializerSettings? settings) =>
        m.Converter is { } converter ? FromStored(converter, value, target)
        : TypeNames.IsNested(m.Column.Type) && value is JsonNode node ? Nested.FromJson(node, target, settings)
        : Convert(value, target, settings);

    private static readonly MethodInfo NestedFromJsonMethod = typeof(Nested).GetMethod(nameof(Nested.FromJson))!;

    private static object? FromStored(JazminConverter converter, object stored, Type target)
    {
        try
        {
            return converter.FromStored(stored, Nullable.GetUnderlyingType(target) ?? target);
        }
        catch (Exception e) when (e is InvalidCastException or FormatException or OverflowException or ArgumentException)
        {
            throw new JazminValidationException($"{converter.GetType().Name} could not read a {stored.GetType().Name} value as {target.Name}", e);
        }
    }

    private static readonly MethodInfo FromStoredMethod = typeof(TypeMap).GetMethod(nameof(FromStored), BindingFlags.Static | BindingFlags.NonPublic)!;

    /// <summary>
    /// Resolves each property to a column position once and compiles the whole row -> instance
    /// step into one method: per row that is one call, with direct unboxing and property stores
    /// instead of a converter and a setter delegate per property.
    /// </summary>
    private Materializer BuildMaterializer(IReadOnlyList<JazminColumn> columns)
    {
        var values = Expression.Parameter(typeof(object?[]), "values");
        var settings = Expression.Parameter(typeof(JazminSerializerSettings), "settings");
        var item = Expression.Variable(_type, "item");
        var value = Expression.Variable(typeof(object), "value");
        var body = new List<Expression> { Expression.Assign(item, Expression.New(_defaultCtor!)) };
        foreach (var m in _members)
        {
            if (m.Set is null) continue;
            var index = IndexOf(columns, m.Column.Name);
            var target = m.Property.PropertyType;
            var property = Expression.Property(item, m.Property);
            var populate = _populate ? Expression.Assign(property, Expression.Constant(m.DefaultValue, target)) : null;
            if (index < 0)
            {
                if (populate is not null) body.Add(populate); // a column the file does not have
                continue;
            }
            var skipNull = target.IsValueType && Nullable.GetUnderlyingType(target) is null;
            var converted = m.Converter is not null
                ? Expression.Convert(Expression.Call(FromStoredMethod, Expression.Constant(m.Converter), value, Expression.Constant(target)), target)
                : ConvertExpression(value, columns[index].Type, target, settings);
            body.Add(Expression.Assign(value, Expression.ArrayIndex(values, Expression.Constant(index))));
            var isNull = Expression.Equal(value, Expression.Constant(null));
            body.Add(populate is not null ? Expression.IfThenElse(isNull, populate, Expression.Assign(property, converted))
                : skipNull ? Expression.IfThen(Expression.Not(isNull), Expression.Assign(property, converted))
                : Expression.Assign(property, Expression.Condition(isNull, Expression.Default(target), converted)));
        }
        body.Add(Expression.Convert(item, typeof(object)));
        var compiled = Expression.Lambda<Func<object?[], JazminSerializerSettings?, object>>(Expression.Block(new[] { item, value }, body), values, settings).Compile();
        Interlocked.Increment(ref _compilations);
        return new Materializer(columns, compiled);
    }

    /// <summary>A compiled column reader for one column layout, as one record: read and written in one step.</summary>
    private sealed record ColumnReaderCode(IReadOnlyList<JazminColumn> Columns, bool[]? Only, Func<DecodedColumn?[], int, JazminSerializerSettings?, object> Read, bool[] Wanted);

    private ColumnReaderCode? _lastColumnReader; // racy but safe: reference writes are atomic

    /// <summary>
    /// A compiled reader that builds one instance from a decoded columnar chunk (typed arrays): no boxing, no row array.
    /// <c>Wanted</c> marks the columns the type maps, so other columns are not decoded at all.
    /// Same conversions and null handling as the materializer, and like it reused for files with the same columns; the
    /// settings are an argument. Null when the type has no parameterless constructor, or rows can be of several types or
    /// refer to each other (those are read row by row). <c>Wanted</c> is shared: callers must not change it.
    /// With <paramref name="only"/> (a LINQ query reading some columns), members of other columns are left unset.
    /// </summary>
    public (Func<DecodedColumn?[], int, JazminSerializerSettings?, object> Read, bool[] Wanted)? ColumnReader(IReadOnlyList<JazminColumn> columns, bool[]? only = null)
    {
        if (_defaultCtor is null || _derived is not null || _preserveReferences) return null;
        if (_lastColumnReader is { } cached && (ReferenceEquals(cached.Columns, columns) || SameLayout(cached.Columns, columns))
            && (cached.Only is null ? only is null : only is not null && cached.Only.AsSpan().SequenceEqual(only)))
            return (cached.Read, cached.Wanted);

        var cols = Expression.Parameter(typeof(DecodedColumn?[]), "columns");
        var row = Expression.Parameter(typeof(int), "row");
        var settings = Expression.Parameter(typeof(JazminSerializerSettings), "settings");
        var item = Expression.Variable(_type, "item");
        var body = new List<Expression> { Expression.Assign(item, Expression.New(_defaultCtor)) };
        var wanted = new bool[columns.Count];
        foreach (var m in _members)
        {
            if (m.Set is null) continue;
            var target = m.Property.PropertyType;
            var property = Expression.Property(item, m.Property);
            var populate = _populate ? Expression.Assign(property, Expression.Constant(m.DefaultValue, target)) : null;
            var j = IndexOf(columns, m.Column.Name);
            if (j < 0 || wanted[j] || (only is not null && !only[j]))
            {
                if (j < 0 && populate is not null) body.Add(populate);
                continue;
            }
            wanted[j] = true;
            var type = columns[j].Type;
            var holder = type switch
            {
                JazminType.Int or JazminType.DateTime => typeof(LongValues),
                JazminType.Float => typeof(DoubleValues),
                JazminType.Bool => typeof(BoolValues),
                JazminType.String or JazminType.Decimal => typeof(StringValues),
                JazminType.Json => typeof(JsonValues),
                JazminType.List or JazminType.Object => typeof(NestedValues),
                _ => typeof(BlobValues),
            };
            var column = Expression.Convert(Expression.ArrayIndex(cols, Expression.Constant(j)), holder);
            var rawJson = type == JazminType.Json && m.Converter is null && target != typeof(JsonNode) && target != typeof(object)
                && target != typeof(JsonObject) && target != typeof(JsonArray) && target != typeof(JsonValue);
            var nestedRead = TypeNames.IsNested(type) && m.Converter is null;
            Expression read = nestedRead
                ? Expression.Call(column, typeof(NestedValues).GetMethod(nameof(NestedValues.Read))!, row, Expression.Constant(target, typeof(Type)), settings)
                : rawJson
                ? Expression.Call(DeserializeRawMethod, Expression.ArrayIndex(Expression.Property(column, "Raw"), row), Expression.Constant(target), settings)
                : type is JazminType.Json or JazminType.List or JazminType.Object ? Expression.Call(column, typeof(DecodedColumn).GetMethod(nameof(DecodedColumn.Get))!, row)
                : Expression.ArrayIndex(Expression.Property(column, "Values"), row);
            if (type == JazminType.DateTime) read = Expression.Call(FromEpochMsMethod, read);
            else if (type == JazminType.Binary) read = Expression.Convert(read, typeof(byte[]));
            else if (type is JazminType.Json or JazminType.List or JazminType.Object && !rawJson && !nestedRead) read = Expression.Convert(read, typeof(JsonNode));
            var isNull = Expression.Call(column, nameof(DecodedColumn.IsNull), null, row);
            var converted = rawJson || nestedRead ? Expression.Convert(read, target)
                : m.Converter is not null
                ? Expression.Convert(Expression.Call(FromStoredMethod, Expression.Constant(m.Converter), Expression.Convert(read, typeof(object)), Expression.Constant(target)), target)
                : TypedConvert(read, type, target, settings);
            var assign = Expression.Assign(property, converted);
            var skipNull = target.IsValueType && Nullable.GetUnderlyingType(target) is null;
            body.Add(populate is not null ? Expression.IfThenElse(isNull, populate, assign)
                : skipNull ? Expression.IfThen(Expression.Not(isNull), assign)
                : Expression.IfThenElse(isNull, Expression.Assign(property, Expression.Default(target)), assign));
        }
        body.Add(Expression.Convert(item, typeof(object)));
        var compiled = Expression.Lambda<Func<DecodedColumn?[], int, JazminSerializerSettings?, object>>(Expression.Block(new[] { item }, body), cols, row, settings).Compile();
        Interlocked.Increment(ref _compilations);
        _lastColumnReader = new ColumnReaderCode(columns, only, compiled, wanted);
        return (compiled, wanted);
    }

    private static readonly MethodInfo FromEpochMsMethod = typeof(Values).GetMethod(nameof(Values.FromEpochMs))!;

    private static readonly MethodInfo DeserializeRawMethod = typeof(TypeMap).GetMethod(nameof(DeserializeRaw), BindingFlags.NonPublic | BindingFlags.Static)!;

    /// <summary>
    /// A json value as stored (UTF-8), straight into the property's type: no text, no JsonNode in between. Errors as
    /// before: JSON that is not valid is a damaged file, valid JSON that does not fit the type a conversion error.
    /// </summary>
    internal static object? DeserializeRaw(byte[] utf8, Type target, JazminSerializerSettings? settings)
    {
        if (utf8 is [(byte)'n', (byte)'u', (byte)'l', (byte)'l']) throw new JazminFormatException("json value is null"); // nulls are stored as nulls
        try
        {
            return JsonSerializer.Deserialize(utf8, target, settings?.EffectiveJsonOptions);
        }
        catch (JsonException e)
        {
            if (!IsJson(utf8)) throw new JazminFormatException("A json value is not valid JSON", e);
            throw new JazminValidationException($"Cannot convert a json value to {target.Name}", e);
        }
    }

    private static bool IsJson(byte[] utf8)
    {
        try
        {
            var reader = new Utf8JsonReader(utf8);
            while (reader.Read())
            {
            }
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }
    /// <summary>Converts a typed value expression to the property type.</summary>
    internal static Expression TypedConvert(Expression read, JazminType columnType, Type target, ParameterExpression settings)
    {
        var t = Nullable.GetUnderlyingType(target) ?? target;
        Expression typed;
        if (t == read.Type) typed = read;
        else if (columnType == JazminType.Int && t == typeof(int)) typed = Expression.ConvertChecked(read, typeof(int));
        else if (columnType == JazminType.Float && t == typeof(float)) typed = Expression.Convert(read, typeof(float));
        else if (t == typeof(object)) typed = Expression.Convert(read, typeof(object));
        else return Expression.Convert(Expression.Call(ConvertMethod, Expression.Convert(read, typeof(object)), Expression.Constant(target, typeof(Type)), settings), target);
        return typed.Type == target ? typed : Expression.Convert(typed, target);
    }

    private static readonly MethodInfo ConvertMethod = typeof(TypeMap).GetMethod(nameof(Convert), BindingFlags.Static | BindingFlags.NonPublic)!;

    /// <summary>
    /// A typed expression converting a non-null stored value to the property type: plain unboxing when
    /// the stored value already has that type, cheap casts for common numerics, otherwise Convert().
    /// </summary>
    private static Expression ConvertExpression(ParameterExpression value, JazminType columnType, Type target, ParameterExpression settings)
    {
        var t = Nullable.GetUnderlyingType(target) ?? target;
        var natural = columnType switch
        {
            JazminType.Bool => typeof(bool),
            JazminType.Int => typeof(long),
            JazminType.Float => typeof(double),
            JazminType.Decimal or JazminType.String => typeof(string),
            JazminType.DateTime => typeof(DateTime),
            JazminType.Binary => typeof(byte[]),
            _ => typeof(JsonNode),
        };
        Expression typed;
        if (TypeNames.IsNested(columnType) && t != typeof(object) && !typeof(JsonNode).IsAssignableFrom(t))
            return Expression.Convert(Expression.Call(NestedFromJsonMethod, Expression.Convert(value, typeof(JsonNode)), Expression.Constant(target, typeof(Type)), settings), target);
        if (t == typeof(object)) typed = value;
        else if (t == natural) typed = Expression.Convert(value, t);
        else if (columnType == JazminType.Int && t == typeof(int)) typed = Expression.ConvertChecked(Expression.Convert(value, typeof(long)), typeof(int));
        else if (columnType == JazminType.Float && t == typeof(float)) typed = Expression.Convert(Expression.Convert(value, typeof(double)), typeof(float));
        else return Expression.Convert(Expression.Call(ConvertMethod, value, Expression.Constant(target, typeof(Type)), settings), target);
        return typed.Type == target ? typed : Expression.Convert(typed, target);
    }

    /// <summary>
    /// Whether two files' columns have the same names, types and order: all the compiled code depends on (it binds each
    /// property to a column position and converts from the column's type).
    /// </summary>
    private static bool SameLayout(IReadOnlyList<JazminColumn> a, IReadOnlyList<JazminColumn> b)
    {
        if (a.Count != b.Count) return false;
        for (var i = 0; i < a.Count; i++)
            if (a[i].Type != b[i].Type || !string.Equals(a[i].Name, b[i].Name, StringComparison.Ordinal)) return false;
        return true;
    }

    private static int IndexOf(IReadOnlyList<JazminColumn> columns, string name)
    {
        for (var i = 0; i < columns.Count; i++)
            if (columns[i].Name == name) return i;
        for (var i = 0; i < columns.Count; i++)
            if (string.Equals(columns[i].Name, name, StringComparison.OrdinalIgnoreCase)) return i;
        return -1;
    }

    /// <summary>Exact name match first, then case-insensitive (as Newtonsoft does by default).</summary>
    private static bool TryGet(IReadOnlyDictionary<string, object?> row, string name, out object? value)
    {
        if (row.TryGetValue(name, out value)) return true;
        foreach (var (key, v) in row)
        {
            if (!string.Equals(key, name, StringComparison.OrdinalIgnoreCase)) continue;
            value = v;
            return true;
        }
        return false;
    }

    internal static object? Convert(object? value, Type target, JazminSerializerSettings? settings)
    {
        try
        {
            return ConvertValue(value, target, settings);
        }
        catch (Exception e) when (e is InvalidCastException or FormatException or OverflowException or ArgumentException or IndexOutOfRangeException or System.Text.Json.JsonException)
        {
            throw new JazminValidationException($"Cannot convert a {value!.GetType().Name} value to {target.Name}", e);
        }
    }

    private static object? ConvertValue(object? value, Type target, JazminSerializerSettings? settings)
    {
        if (value is null) return null;
        var t = Nullable.GetUnderlyingType(target) ?? target;
        if (t.IsInstanceOfType(value)) return value;
        if (t.IsEnum) return Enum.Parse(t, (string)value, ignoreCase: true);
        if (value is JsonNode node) return node.Deserialize(target, settings?.EffectiveJsonOptions);
        if (value is DateTime dt)
        {
            if (t == typeof(DateTimeOffset)) return new DateTimeOffset(dt, TimeSpan.Zero);
            if (t == typeof(DateOnly)) return DateOnly.FromDateTime(dt);
        }
        if (value is string s)
        {
            if (t == typeof(Guid)) return Guid.Parse(s);
            if (t == typeof(char)) return s[0];
            if (t == typeof(TimeSpan)) return TimeSpan.Parse(s, CultureInfo.InvariantCulture);
            if (t == typeof(TimeOnly)) return TimeOnly.Parse(s, CultureInfo.InvariantCulture);
            if (t == typeof(decimal)) return decimal.Parse(s, NumberStyles.Number, CultureInfo.InvariantCulture);
            if (t == typeof(double)) return double.Parse(s, CultureInfo.InvariantCulture);
        }
        return System.Convert.ChangeType(value, t, CultureInfo.InvariantCulture);
    }
}

/// <summary>Writing with PreserveReferencesHandling: the ids of the objects written so far.</summary>
internal sealed class ReferenceTracker
{
    private readonly Dictionary<object, string> _ids = new(ReferenceEqualityComparer.Instance);

    public bool TryGetId(object item, out string id) => _ids.TryGetValue(item, out id!);

    public string Add(object item)
    {
        var id = (_ids.Count + 1).ToString(CultureInfo.InvariantCulture); // "1", "2"... as Newtonsoft writes them
        _ids.Add(item, id);
        return id;
    }
}

/// <summary>Reading with PreserveReferencesHandling: the objects read so far, by id.</summary>
internal sealed class ReferenceResolver
{
    private readonly Dictionary<string, object> _items = new(StringComparer.Ordinal);

    public void Add(string id, object item) => _items[id] = item;

    public object Get(string id) =>
        _items.TryGetValue(id, out var item) ? item : throw new JazminFormatException($"A row refers to object {id}, which no earlier row defines");
}
