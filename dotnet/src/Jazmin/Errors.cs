namespace Jazmin;

/// <summary>Base class for all JAZMIN errors.</summary>
public class JazminException : Exception
{
    public JazminException(string message) : base(message) { }
    public JazminException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>The file is not valid JAZMIN, is truncated, or failed an integrity check.</summary>
public class JazminFormatException : JazminException
{
    public JazminFormatException(string message) : base(message) { }
    public JazminFormatException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>A key or password is missing, malformed or wrong.</summary>
public class JazminKeyException : JazminException
{
    public JazminKeyException(string message) : base(message) { }
    public JazminKeyException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>The caller supplied invalid data, schema, filter or options.</summary>
public class JazminValidationException : JazminException
{
    public JazminValidationException(string message) : base(message) { }
    public JazminValidationException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>The key's access period has ended, or the system clock appears to have been set back.</summary>
public class JazminAccessExpiredException : JazminKeyException
{
    public JazminAccessExpiredException(string message) : base(message) { }
}

/// <summary>
/// An online key needs an unlock token from the file owner's key service. <see cref="FileId"/> and
/// <see cref="KeyId"/> identify what to ask for (e.g. send them to your secrets API).
/// </summary>
public class JazminUnlockRequiredException : JazminKeyException
{
    public JazminUnlockRequiredException(string message, string fileId, string keyId) : base(message)
    {
        FileId = fileId;
        KeyId = keyId;
    }

    public string FileId { get; }

    public string KeyId { get; }
}
