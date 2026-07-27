import { DomainError, safeValue } from "../shared/errors";
import { parsePluginEvent, type PluginEvent } from "../shared/protocol";

/**
 * Validates direct plugin events and Joplin desktop's JSON message envelope.
 *
 * @example parseWebviewPluginEvent({ message: '{"version":2,...}' })
 */
export function parseWebviewPluginEvent(input: unknown): PluginEvent {
  const message = unwrapDesktopMessage(input);
  return parsePluginEvent(decodeJsonMessage(message));
}

function unwrapDesktopMessage(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  if (!Object.prototype.hasOwnProperty.call(input, "message")) return input;
  return (input as Record<string, unknown>).message;
}

function decodeJsonMessage(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch (cause: unknown) {
    throw new DomainError(
      "VALIDATION",
      `Invalid plugin transport message ${safeValue(input)}; expected a JSON-encoded plugin event`,
      cause,
    );
  }
}
