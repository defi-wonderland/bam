/**
 * Safe Postgres identifier quoting. Wraps `id` in double-quotes and
 * escapes any embedded `"` per Postgres rules (`"` → `""`). The result
 * is safe to splice into a SQL string for schema / table / column
 * names — quoted identifiers preserve case and accept arbitrary
 * characters (hyphens, reserved words, etc.) except a literal NUL.
 *
 * Postgres caps identifier length at NAMEDATALEN-1 (63 bytes by
 * default). We don't pre-check the length: the server returns a clear
 * "identifier too long" error and clamping client-side would just
 * mask a misconfiguration.
 */
export function quoteIdent(id: string): string {
  if (id.length === 0) {
    throw new Error('quoteIdent: identifier must be non-empty');
  }
  if (id.indexOf('\x00') !== -1) {
    throw new Error('quoteIdent: identifier contains a null byte');
  }
  return `"${id.replace(/"/g, '""')}"`;
}
