/**
 * True when `url` is an absolute http or https link safe to open externally.
 *
 * @example isSafeExternalMarkdownUrl("https://example.test")
 */
export function isSafeExternalMarkdownUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
