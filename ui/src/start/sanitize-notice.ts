/**
 * A feed notification's body is remote HTML, and this page holds the shell
 * bridge — so it only ever renders a sanitized copy. Formatting tags and
 * http(s) links survive; dangerous elements are dropped with their content;
 * anything else is unwrapped to its children; every attribute except a link's
 * http(s) `href` is removed. The page's CSP (no inline script) is the second
 * line of defence, not the first.
 */

/** Kept, minus their attributes. */
const KEEP_TAGS = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'U', 'CODE', 'BR', 'P', 'SPAN', 'UL', 'OL', 'LI']);

/** Removed together with everything inside them. */
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'TEMPLATE', 'SVG', 'MATH', 'NOSCRIPT']);

const HTTP_URL = /^https?:\/\//;

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/**
 * Upper-cased for every namespace: an element inside `<svg>` or `<math>`
 * reports a lower-case `tagName` (`svg`, `script`), which an upper-case set
 * silently misses — the SVG would be unwrapped instead of dropped.
 */
function tagOf(el: Element): string {
  return el.tagName.toUpperCase();
}

/** Only HTML elements are kept; an SVG `<a>` is not the HTML one, whatever its name. */
function isKept(el: Element): boolean {
  return el.namespaceURI === HTML_NAMESPACE && KEEP_TAGS.has(tagOf(el));
}

function keepsAttribute(el: Element, name: string): boolean {
  return tagOf(el) === 'A' && name === 'href' && HTTP_URL.test(el.getAttribute('href') ?? '');
}

/** The sanitized body as a fragment of `doc`, ready to append. */
export function sanitizeNoticeHtml(html: string, doc: Document = document): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const el of [...parsed.body.querySelectorAll('*')]) {
    if (DROP_TAGS.has(tagOf(el))) {
      el.remove();
      continue;
    }
    if (!isKept(el)) {
      el.replaceWith(...el.childNodes);
      continue;
    }
    for (const attr of [...el.attributes]) {
      if (!keepsAttribute(el, attr.name)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  const fragment = doc.createDocumentFragment();
  fragment.append(...[...parsed.body.childNodes].map((node) => doc.importNode(node, true)));
  return fragment;
}
