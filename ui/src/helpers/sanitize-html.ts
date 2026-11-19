/**
 * An allowlist walker over an HTML string: parse it inert with `DOMParser`,
 * keep only the elements and attributes a policy names, and hand back a
 * fragment of the live document. Nothing in the string runs — a parsed
 * document has no browsing context — and nothing outside the allowlist
 * reaches the page.
 *
 * - Elements in {@link HtmlPolicy.drop} go with everything inside them.
 * - Elements not in {@link HtmlPolicy.keep} (and every element outside the
 *   HTML namespace: an SVG `<a>` is not the HTML one) are unwrapped to their
 *   children.
 * - Every attribute goes, except what {@link HtmlPolicy.attribute} returns a
 *   value for.
 *
 * Shared by the start page's feed notices and the chat's colourised code;
 * it must stay free of imports (the start page's build denies most of the
 * product's modules).
 */
export type HtmlPolicy = {
  /** Upper-case tag names kept (minus their attributes). */
  keep: ReadonlySet<string>;
  /** Upper-case tag names removed together with their content. */
  drop: ReadonlySet<string>;
  /** The value to keep for `name` on `el`, or null to remove it. Absent: every attribute goes. */
  attribute?(el: Element, name: string, value: string): string | null;
};

/** Removed with their content by every policy that does not say otherwise. */
export const DANGEROUS_TAGS: ReadonlySet<string> = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'TEMPLATE', 'SVG', 'MATH', 'NOSCRIPT',
]);

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/**
 * Upper-cased for every namespace: an element inside `<svg>` or `<math>`
 * reports a lower-case `tagName` (`svg`, `script`), which an upper-case set
 * silently misses — the SVG would be unwrapped instead of dropped.
 */
function tagOf(el: Element): string {
  return el.tagName.toUpperCase();
}

/** The sanitized `html` as a fragment of `doc`, ready to append. */
export function sanitizeHtml(html: string, policy: HtmlPolicy, doc: Document = document): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const el of [...parsed.body.querySelectorAll('*')]) {
    if (!el.isConnected) {
      // Inside an element already dropped.
      continue;
    }
    if (policy.drop.has(tagOf(el))) {
      el.remove();
      continue;
    }
    if (el.namespaceURI !== HTML_NAMESPACE || !policy.keep.has(tagOf(el))) {
      el.replaceWith(...el.childNodes);
      continue;
    }
    for (const attr of [...el.attributes]) {
      const kept = policy.attribute?.(el, attr.name, attr.value) ?? null;
      if (kept === null) {
        el.removeAttribute(attr.name);
      } else if (kept !== attr.value) {
        el.setAttribute(attr.name, kept);
      }
    }
  }
  const fragment = doc.createDocumentFragment();
  fragment.append(...[...parsed.body.childNodes].map((node) => doc.importNode(node, true)));
  return fragment;
}
