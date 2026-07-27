import { DomainError } from "../shared/errors";
import type { ProviderConfig } from "./types";

function endpointDisplay(value: string): string {
  try {
    const endpoint = new URL(value);
    if (endpoint.username) endpoint.username = "[redacted]";
    if (endpoint.password) endpoint.password = "[redacted]";
    return endpoint.toString();
  } catch {
    return value.slice(0, 500);
  }
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]"
  );
}

/**
 * Validates and normalizes an OpenAI-compatible endpoint configuration.
 *
 * @example validateProviderConfig({ ...config, baseUrl: 'http://localhost:11434/v1' })
 */
export function validateProviderConfig(config: ProviderConfig): ProviderConfig {
  const endpoint = parseEndpoint(config.baseUrl);
  validateEndpointSecurity(endpoint, config);
  if (!config.model.trim()) {
    throw new DomainError(
      "VALIDATION",
      `Invalid model ${JSON.stringify(config.model)}; expected a non-empty model name`,
    );
  }
  if (config.timeoutMs < 1_000 || config.timeoutMs > 600_000) {
    throw new DomainError(
      "VALIDATION",
      `Invalid timeout ${config.timeoutMs}; expected 1000..600000 milliseconds`,
    );
  }

  return {
    ...config,
    baseUrl: ensureTrailingSlash(endpoint),
    model: config.model.trim(),
  };
}

function parseEndpoint(value: string): URL {
  try {
    const endpoint = new URL(value);
    if (!["http:", "https:"].includes(endpoint.protocol))
      throw new Error("protocol");
    if (endpoint.username || endpoint.password) throw new Error("credentials");
    if (endpoint.search || endpoint.hash) throw new Error("query");
    return endpoint;
  } catch {
    throw new DomainError(
      "VALIDATION",
      `Invalid base URL ${endpointDisplay(value)}; expected HTTP(S) without credentials, query, or fragment`,
    );
  }
}

function validateEndpointSecurity(endpoint: URL, config: ProviderConfig): void {
  if (endpoint.protocol !== "http:" || isLoopback(endpoint.hostname)) return;
  if (config.allowInsecureRemote) return;
  throw new DomainError(
    "SECURITY",
    `Remote HTTP endpoint ${endpoint.origin} requires explicit security confirmation; expected HTTPS or localhost`,
  );
}

function ensureTrailingSlash(endpoint: URL): string {
  if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
  return endpoint.toString();
}
