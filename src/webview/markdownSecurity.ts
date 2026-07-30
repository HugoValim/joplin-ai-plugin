import { isSafeExternalMarkdownUrl } from "../shared/safeExternalUrl";

export { isSafeExternalMarkdownUrl };

/**
 * Allows in-page anchors and absolute http(s) URLs in sidebar markdown.
 *
 * @example safeMarkdownUrlTransform("https://example.test/doc")
 */
export function safeMarkdownUrlTransform(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("#")) return trimmed;
  if (isSafeExternalMarkdownUrl(trimmed)) return trimmed;
  return "";
}
