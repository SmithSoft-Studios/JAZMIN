export class JazminError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

/** The file is not valid JAZMIN, is truncated, or failed an integrity check. */
export class JazminFormatError extends JazminError {}

/** A key or password is missing, malformed, or wrong. */
export class JazminKeyError extends JazminError {}

/** Caller supplied invalid data, schema, filter or options. */
export class JazminValidationError extends JazminError {}

/** The key's access period has ended, or the system clock appears to have been set back. */
export class JazminAccessExpiredError extends JazminKeyError {}

/**
 * An online key needs an unlock token from the file owner's key service. `fileId` and `keyId`
 * identify what to ask for (e.g. send them to your secrets API).
 */
export class JazminUnlockRequiredError extends JazminKeyError {
  constructor(message, { fileId, keyId }) {
    super(message);
    this.fileId = fileId;
    this.keyId = keyId;
  }
}
