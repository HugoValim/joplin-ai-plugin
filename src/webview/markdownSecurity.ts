/**
 * Blocks remote URLs in sidebar markdown while allowing in-page anchors.
 *
 * @example safeMarkdownUrlTransform("https://evil.test/track")
 */
export function safeMarkdownUrlTransform(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith("#")) return trimmed;
  return "";
}
