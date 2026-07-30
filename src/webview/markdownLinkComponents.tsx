import type { Components } from "react-markdown";
import { isSafeExternalMarkdownUrl } from "./markdownSecurity";

/**
 * Builds react-markdown link components that open externally via callback.
 *
 * @example const components = markdownLinkComponents(onOpenLink)
 */
export function markdownLinkComponents(
  onOpenLink: (url: string) => void,
): Components {
  return {
    a: ({ href, children }) => (
      <a
        className="markdown-link"
        href={href ?? undefined}
        onClick={(event) =>
          handleMarkdownLinkActivation(event, href, onOpenLink)
        }
        onAuxClick={(event) =>
          handleMarkdownLinkActivation(event, href, onOpenLink)
        }
      >
        {children}
      </a>
    ),
  };
}

function handleMarkdownLinkActivation(
  event: { preventDefault(): void },
  href: string | undefined,
  onOpenLink: (url: string) => void,
): void {
  if (!href || href.startsWith("#")) return;
  event.preventDefault();
  if (!isSafeExternalMarkdownUrl(href)) return;
  onOpenLink(href);
}
