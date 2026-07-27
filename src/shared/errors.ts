export type DomainErrorCode =
  | "ABORTED"
  | "CONFLICT"
  | "INTERNAL"
  | "LIMIT_EXCEEDED"
  | "NETWORK"
  | "NOT_AVAILABLE"
  | "PROVIDER"
  | "SECURITY"
  | "VALIDATION";

export class DomainError extends Error {
  public constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

const SECRET_FIELD = /api.?key|authorization|password|secret|token/i;

/**
 * Formats an offending external value without exposing credential fields.
 *
 * @example safeValue({ apiKey: 'private' }) // '{"apiKey":"[redacted]"}'
 */
export function safeValue(input: unknown): string {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(input, (key: string, value: unknown): unknown => {
    if (SECRET_FIELD.test(key)) return "[redacted]";
    if (typeof value !== "object" || value === null) return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value;
  });

  return (json ?? String(input)).slice(0, 500);
}
