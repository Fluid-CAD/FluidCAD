/**
 * A feed notification's body is remote HTML, and this page holds the shell
 * bridge — so it only ever renders a sanitized copy. Formatting tags and
 * http(s) links survive; dangerous elements are dropped with their content;
 * anything else is unwrapped to its children; every attribute except a link's
 * http(s) `href` is removed. The page's CSP (no inline script) is the second
 * line of defence, not the first. The walk itself is the shared
 * {@link sanitizeHtml}.
 */

import { DANGEROUS_TAGS, sanitizeHtml, type HtmlPolicy } from '../helpers/sanitize-html';

const HTTP_URL = /^https?:\/\//;

const NOTICE_POLICY: HtmlPolicy = {
  /** Kept, minus their attributes. */
  keep: new Set(['A', 'B', 'STRONG', 'I', 'EM', 'U', 'CODE', 'BR', 'P', 'SPAN', 'UL', 'OL', 'LI']),
  drop: DANGEROUS_TAGS,
  attribute: (el, name, value) => (el.tagName.toUpperCase() === 'A' && name === 'href' && HTTP_URL.test(value) ? value : null),
};

/** The sanitized body as a fragment of `doc`, ready to append. */
export function sanitizeNoticeHtml(html: string, doc: Document = document): DocumentFragment {
  return sanitizeHtml(html, NOTICE_POLICY, doc);
}
