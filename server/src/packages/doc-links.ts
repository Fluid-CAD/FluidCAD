import path from 'path';

/** One link or image target a markdown page writes, as written. */
export type DocLink = {
  /** The target, as written (`./images/standoff.svg`, `../README.md#usage`, `https://…`). */
  target: string;
  /** 1-based. */
  line: number;
};

/** Where a relative link leads: the package path it names, or out of the package. */
export type DocLinkTarget =
  | { kind: 'file'; path: string }
  | { kind: 'outside' };

/**
 * The links of a package's doc pages (package-docs DOC6), read with a small
 * scanner rather than a markdown parser: inline links and images
 * (`[text](target)`, `![alt](target "title")`, `[![alt](img)](link)`) and
 * reference definitions (`[ref]: target`). Code spans and fenced code
 * blocks are skipped, so an example that shows link syntax is not a link.
 *
 * Pack warns about a relative target that leads to no shipped file or out
 * of the package (`docs-link`); absolute URLs, in-page anchors and other
 * schemes are never checked.
 */
export class DocLinks {
  /** A fence line opening or closing a fenced block: up to three spaces, then three or more backticks or tildes. */
  private static readonly FENCE = /^ {0,3}(`{3,}|~{3,})/;
  /** A reference definition: `[ref]: target` or `[ref]: <target>`, up to three spaces in. */
  private static readonly DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/;
  /** A code span: a run of backticks, anything, then the same run again and no more. */
  private static readonly CODE_SPAN = /(`+)(?:.*?[^`])?\1(?!`)/g;
  /** A URL scheme (`https:`, `mailto:`): the target is absolute. */
  private static readonly SCHEME = /^[a-z][a-z0-9+.-]*:/i;

  /** Every link and image target the page writes, in order. */
  static scan(markdown: string): DocLink[] {
    const out: DocLink[] = [];
    let fence: string | null = null;
    const lines = markdown.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const marker = DocLinks.FENCE.exec(line)?.[1] ?? null;
      if (fence !== null) {
        // A fence closes on a run of its own character at least as long, and nothing else on the line.
        if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
          fence = null;
        }
        continue;
      }
      if (marker !== null) {
        fence = marker;
        continue;
      }
      const definition = DocLinks.DEFINITION.exec(line);
      if (definition) {
        out.push({ target: DocLinks.unwrap(definition[1]), line: i + 1 });
        continue;
      }
      const text = line.replace(DocLinks.CODE_SPAN, (span) => ' '.repeat(span.length));
      for (const target of DocLinks.inlineTargets(text)) {
        out.push({ target, line: i + 1 });
      }
    }
    return out;
  }

  /**
   * Where a target written in `page` leads, or null when it is not a
   * relative link the package must hold: an absolute URL, another scheme,
   * a protocol-relative `//host` or an in-page `#anchor`. The query and the
   * fragment are left out; a root-absolute `/x` leads out of the package.
   */
  static resolve(page: string, target: string): DocLinkTarget | null {
    if (target === '' || target.startsWith('#') || target.startsWith('//') || DocLinks.SCHEME.test(target)) {
      return null;
    }
    const bare = target.replace(/[?#].*$/, '');
    if (bare === '') {
      return null;
    }
    let decoded = bare;
    try {
      decoded = decodeURIComponent(bare);
    } catch {
      decoded = bare;
    }
    if (decoded.startsWith('/')) {
      return { kind: 'outside' };
    }
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(page), decoded));
    if (joined === '..' || joined.startsWith('../')) {
      return { kind: 'outside' };
    }
    // A folder (`./images/`, or `..` to the root) names no file: it is checked as one, and found missing.
    return { kind: 'file', path: joined.replace(/\/+$/, '') };
  }

  /** The targets of a line's inline links and images: what follows each `](` that has a `[` before it. */
  private static inlineTargets(text: string): string[] {
    const out: string[] = [];
    let from = 0;
    for (;;) {
      const at = text.indexOf('](', from);
      if (at < 0) {
        return out;
      }
      from = at + 2;
      if (text.lastIndexOf('[', at) < 0) {
        continue;
      }
      const target = DocLinks.readTarget(text, from);
      if (target !== null) {
        out.push(target);
      }
    }
  }

  /** The destination starting at `from`: `<…>`, or up to whitespace or the `)` that closes it (balanced parentheses kept). */
  private static readTarget(text: string, from: number): string | null {
    let i = from;
    while (text[i] === ' ' || text[i] === '\t') {
      i++;
    }
    if (text[i] === '<') {
      const end = text.indexOf('>', i + 1);
      return end < 0 ? null : text.slice(i + 1, end);
    }
    let depth = 0;
    const start = i;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === ' ' || c === '\t') {
        break;
      }
      if (c === '(') {
        depth++;
      } else if (c === ')') {
        if (depth === 0) {
          break;
        }
        depth--;
      }
    }
    return i < text.length ? text.slice(start, i) : null;
  }

  /** A definition's target without its angle brackets. */
  private static unwrap(target: string): string {
    return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
  }
}
