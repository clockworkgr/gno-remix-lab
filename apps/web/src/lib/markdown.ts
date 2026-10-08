// Renders realm Markdown (Render output) as sanitized HTML. Realm text is
// untrusted: no raw HTML survives, images are replaced by their alt text
// (they would let a realm track viewers), and links are rewritten so realm
// paths open inside the inspector and everything else opens in a new tab.
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { nativeUrl } from "./chain.ts";
import { href } from "./router.ts";

const marked = new Marked({ gfm: true, breaks: false, async: false });

// Raw HTML in the Markdown becomes text, not markup.
marked.use({
  renderer: {
    html: ({ text }) => escapeHtml(text),
    image: ({ text }) => (text ? `<span class="md-img-alt">[image: ${escapeHtml(text)}]</span>` : ""),
  },
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Where a link in a realm page should go. */
export function rewriteLink(raw: string, networkId: string): { href: string; external: boolean } | null {
  // gnoweb action links ("/r/x$help&func=Join") open the native help page.
  const realm = /^\/((?:r|p)\/[a-z0-9_\-/.]+?)(?::([^$]*))?(\$.*)?$/i.exec(raw);
  if (realm) {
    const pkgPath = `gno.land/${realm[1]!.replace(/\/+$/, "")}`;
    if (realm[3]) {
      const native = nativeUrl(networkId, pkgPath);
      return native ? { href: native + realm[3], external: true } : null;
    }
    return { href: href(`/apps/${pkgPath}`, { net: networkId, tab: "page", ...(realm[2] ? { path: realm[2] } : {}) }), external: false };
  }
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" || u.protocol === "http:") return { href: u.toString(), external: true };
  } catch {
    // relative or malformed
  }
  return null;
}

export function renderMarkdown(md: string, networkId: string): string {
  const html = marked.parse(md) as string;
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["img", "style", "form", "input", "button", "iframe", "video", "audio", "svg", "math"],
    FORBID_ATTR: ["style", "srcset"],
    RETURN_TRUSTED_TYPE: false,
  });
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, "text/html");
  for (const a of doc.querySelectorAll("a")) {
    const target = rewriteLink(a.getAttribute("href") ?? "", networkId);
    if (!target) {
      a.removeAttribute("href");
      continue;
    }
    a.setAttribute("href", target.href);
    if (target.external) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer nofollow");
    }
  }
  return doc.body.firstElementChild!.innerHTML;
}
