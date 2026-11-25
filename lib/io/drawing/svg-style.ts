import type { XmlElement } from "./xml.js";

/** One simple selector of a compound: what it asks of the element. */
type Test = (element: XmlElement) => boolean;

/** `div.a#b[c]`: the tests one element has to pass. */
type Compound = { tests: Test[] };

/** Compounds joined by combinators, the rightmost first: `a > b c` is `[c, b, a]` with `[' ', '>']`. */
type Selector = { compounds: Compound[]; combinators: string[]; specificity: number };

type Rule = { selectors: Selector[]; declarations: Map<string, StyleValue>; order: number };

export type StyleValue = { value: string; important: boolean };

/** A property an element is given, with what decides between it and another value for the same property. */
type Candidate = { value: string; weight: number[] };

/**
 * The attributes that set a property, for the properties the import looks
 * at: what is drawn at all (`display`, `visibility`, the paint), where
 * (`transform` and its origin), the geometry SVG 2 lets a style sheet
 * set, and how text is written.
 */
const PRESENTATION_ATTRIBUTES = new Set([
  'display', 'visibility', 'opacity',
  'fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width',
  'clip-path', 'mask',
  'transform', 'transform-origin', 'transform-box',
  'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'd',
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch',
  'text-anchor', 'letter-spacing', 'word-spacing', 'writing-mode', 'direction',
  'dominant-baseline', 'alignment-baseline', 'baseline-shift',
]);

/**
 * The style sheets of an SVG file, and what they give each element.
 *
 * A drawing program may put everything that says how a shape is drawn in a
 * `<style>` block and leave the shapes with a class (Adobe Illustrator does
 * by default), so whether a shape is hidden, painted or moved cannot be
 * read off its attributes alone. This is the part of CSS that takes:
 * selectors by element name, class, id and attribute, joined by descendant,
 * child and sibling combinators, with `:root`, `:first-child`,
 * `:last-child` and `:not()`; specificity, source order and `!important`;
 * the presentation attributes under the rules, the `style` attribute over
 * them. Rules inside `@media` are taken when the query is for a screen or
 * for everything; other at-rules are passed over. A selector with anything
 * else in it — `:hover`, a pseudo-element — matches nothing.
 */
export class SvgStyleSheet {
  private readonly rules: Rule[] = [];
  private readonly cache = new Map<XmlElement, Map<string, string>>();

  /** The sheets of a file, in the order they come in it. */
  constructor(sheets: readonly string[]) {
    for (const sheet of sheets) {
      this.read(SvgStyleSheet.withoutComments(sheet));
    }
  }

  /**
   * The properties the element is given by its attributes, the rules that
   * match it and its `style`, each with the value that wins. What it merely
   * inherits is not here.
   */
  declared(element: XmlElement): Map<string, string> {
    const cached = this.cache.get(element);
    if (cached) {
      return cached;
    }
    const candidates = new Map<string, Candidate>();
    const offer = (name: string, value: string, weight: number[]) => {
      const held = candidates.get(name);
      if (!held || SvgStyleSheet.outweighs(weight, held.weight)) {
        candidates.set(name, { value, weight });
      }
    };
    // Weight: important, then where it comes from (attribute, sheet, style), specificity, order.
    let inline: string | undefined;
    for (const attribute of element.attributes) {
      if (attribute.namespace !== '') {
        continue;
      }
      if (attribute.name === 'style') {
        inline = attribute.value;
      } else if (PRESENTATION_ATTRIBUTES.has(attribute.name)) {
        offer(attribute.name, attribute.value.trim(), [0, 0, 0, 0]);
      }
    }
    for (const rule of this.rules) {
      let specificity = -1;
      for (const selector of rule.selectors) {
        if (selector.specificity > specificity && SvgStyleSheet.matches(element, selector, 0)) {
          specificity = selector.specificity;
        }
      }
      if (specificity < 0) {
        continue;
      }
      for (const [name, declaration] of rule.declarations) {
        offer(name, declaration.value, [declaration.important ? 1 : 0, 1, specificity, rule.order]);
      }
    }
    if (inline !== undefined) {
      for (const [name, declaration] of SvgStyleSheet.declarations(inline)) {
        offer(name, declaration.value, [declaration.important ? 1 : 0, 2, 0, 0]);
      }
    }
    const declared = new Map<string, string>();
    for (const [name, candidate] of candidates) {
      declared.set(name, candidate.value);
    }
    this.cache.set(element, declared);
    return declared;
  }

  /** `a: b; c: d !important` as its declarations; a later one of the same name replaces an earlier one unless that was important. */
  static declarations(text: string): Map<string, StyleValue> {
    const declarations = new Map<string, StyleValue>();
    for (const part of SvgStyleSheet.split(SvgStyleSheet.withoutComments(text), ';')) {
      const colon = part.indexOf(':');
      if (colon < 0) {
        continue;
      }
      const name = part.slice(0, colon).trim().toLowerCase();
      let value = part.slice(colon + 1).trim();
      const important = /!\s*important\s*$/i.test(value);
      if (important) {
        value = value.replace(/!\s*important\s*$/i, '').trim();
      }
      if (name === '' || value === '') {
        continue;
      }
      const held = declarations.get(name);
      if (!held || important || !held.important) {
        declarations.set(name, { value, important });
      }
    }
    return declarations;
  }

  // ─── Reading ────────────────────────────────────────────────────────────

  private static withoutComments(text: string): string {
    // `<!--` and `-->` around a sheet are allowed and mean nothing.
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--|-->/g, ' ');
  }

  /** `text` cut at each `separator` that is not inside brackets, parentheses or quotes. */
  private static split(text: string, separator: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote = '';
    let from = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\') {
          i++;
        } else if (c === quote) {
          quote = '';
        }
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '(' || c === '[') {
        depth++;
      } else if (c === ')' || c === ']') {
        depth--;
      } else if (c === separator && depth <= 0) {
        parts.push(text.slice(from, i));
        from = i + 1;
      }
    }
    parts.push(text.slice(from));
    return parts;
  }

  /** Where the block that opens at `open` (a `{`) closes; the text's end when it never does. */
  private static blockEnd(text: string, open: number): number {
    let depth = 0;
    let quote = '';
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\') {
          i++;
        } else if (c === quote) {
          quote = '';
        }
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '{') {
        depth++;
      } else if (c === '}' && --depth === 0) {
        return i;
      }
    }
    return text.length;
  }

  private read(text: string): void {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      const semicolon = text.indexOf(';', i);
      const prelude = text.slice(i, open < 0 ? text.length : open).trim();
      if (prelude.startsWith('@') && semicolon >= 0 && (open < 0 || semicolon < open)) {
        // `@import …;`, `@charset …;`, `@namespace …;`: nothing a drawing's geometry comes from.
        i = semicolon + 1;
        continue;
      }
      if (open < 0) {
        break;
      }
      const close = SvgStyleSheet.blockEnd(text, open);
      const body = text.slice(open + 1, close);
      if (prelude.startsWith('@')) {
        const media = /^@media\b(.*)$/is.exec(prelude);
        if (media && SvgStyleSheet.mediaApplies(media[1])) {
          this.read(body);
        }
      } else {
        const selectors: Selector[] = [];
        for (const part of SvgStyleSheet.split(prelude, ',')) {
          const selector = SvgStyleSheet.selector(part);
          if (selector) {
            selectors.push(selector);
          }
        }
        if (selectors.length > 0) {
          this.rules.push({ selectors, declarations: SvgStyleSheet.declarations(body), order: this.rules.length });
        }
      }
      i = close + 1;
    }
  }

  /** A drawing is read the way a screen shows it. */
  private static mediaApplies(query: string): boolean {
    return SvgStyleSheet.split(query, ',').some((part) => {
      const q = part.trim().toLowerCase();
      return q === '' || q === 'all' || q === 'screen' || q === 'only screen';
    });
  }

  // ─── Selectors ──────────────────────────────────────────────────────────

  /** One selector of a rule (no commas); null when it has something this does not read, so the rule never matches by it. */
  private static selector(text: string): Selector | null {
    const compounds: Compound[] = [];
    const combinators: string[] = [];
    let specificity = 0;
    let tests: Test[] = [];
    const source = text.trim();
    if (source === '') {
      return null;
    }
    const name = /[-_a-zA-Z0-9 -￿\\]+/y;
    const readName = (at: number): string | null => {
      name.lastIndex = at;
      const match = name.exec(source);
      return match ? match[0].replace(/\\(.)/g, '$1') : null;
    };
    const close = (): boolean => {
      if (tests.length === 0) {
        return false;
      }
      compounds.unshift({ tests });
      tests = [];
      return true;
    };

    let i = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '>' || c === '+' || c === '~') {
        // A combinator: white space on its own is the descendant one.
        let combinator = ' ';
        while (i < source.length && /[\s>+~]/.test(source[i])) {
          if (source[i] !== ' ' && !/\s/.test(source[i])) {
            if (combinator !== ' ') {
              return null;
            }
            combinator = source[i];
          }
          i++;
        }
        if (i >= source.length) {
          break;
        }
        if (!close()) {
          return null;
        }
        combinators.unshift(combinator);
        continue;
      }
      if (c === '*') {
        tests.push(() => true);
        i++;
      } else if (c === '.') {
        const value = readName(i + 1);
        if (value === null) {
          return null;
        }
        tests.push((element) => SvgStyleSheet.attribute(element, 'class').split(/\s+/).includes(value));
        specificity += 0x100;
        i = name.lastIndex;
      } else if (c === '#') {
        const value = readName(i + 1);
        if (value === null) {
          return null;
        }
        tests.push((element) => SvgStyleSheet.attribute(element, 'id') === value);
        specificity += 0x10000;
        i = name.lastIndex;
      } else if (c === '[') {
        const end = source.indexOf(']', i);
        const test = end < 0 ? null : SvgStyleSheet.attributeTest(source.slice(i + 1, end));
        if (!test) {
          return null;
        }
        tests.push(test);
        specificity += 0x100;
        i = end + 1;
      } else if (c === ':') {
        const pseudo = /:([-a-zA-Z]+)(?:\(([^()]*)\))?/y;
        pseudo.lastIndex = i;
        const match = pseudo.exec(source);
        if (!match) {
          return null;
        }
        const test = SvgStyleSheet.pseudoTest(match[1].toLowerCase(), match[2]);
        if (!test) {
          return null;
        }
        tests.push(test.test);
        specificity += test.specificity;
        i = pseudo.lastIndex;
      } else {
        // An element name, with or without a namespace prefix (`svg|path`).
        let value = readName(i);
        if (value === null) {
          return null;
        }
        i = name.lastIndex;
        if (source[i] === '|') {
          value = source[i + 1] === '*' ? '*' : readName(i + 1);
          if (value === null) {
            return null;
          }
          i = value === '*' ? i + 2 : name.lastIndex;
        }
        const local = value;
        if (local !== '*') {
          tests.push((element) => element.local === local);
          specificity += 1;
        } else {
          tests.push(() => true);
        }
      }
    }
    if (!close()) {
      return null;
    }
    return { compounds, combinators, specificity };
  }

  private static attribute(element: XmlElement, name: string): string {
    for (const attribute of element.attributes) {
      if (attribute.name === name) {
        return attribute.value;
      }
    }
    return '';
  }

  private static attributeTest(body: string): Test | null {
    const match = /^\s*([-_a-zA-Z0-9:|]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(?:[is])?)?\s*$/.exec(body);
    if (!match) {
      return null;
    }
    // `xlink|href` is written `xlink:href` in the file.
    const name = match[1].replace('|', ':');
    const operator = match[2];
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    const has = (element: XmlElement) => element.attributes.some((attribute) => attribute.name === name);
    switch (operator) {
      case undefined:
        return has;
      case '=':
        return (element) => has(element) && SvgStyleSheet.attribute(element, name) === value;
      case '~=':
        return (element) => value !== '' && SvgStyleSheet.attribute(element, name).split(/\s+/).includes(value);
      case '|=':
        return (element) => {
          const held = SvgStyleSheet.attribute(element, name);
          return has(element) && (held === value || held.startsWith(`${value}-`));
        };
      case '^=':
        return (element) => value !== '' && SvgStyleSheet.attribute(element, name).startsWith(value);
      case '$=':
        return (element) => value !== '' && SvgStyleSheet.attribute(element, name).endsWith(value);
      case '*=':
        return (element) => value !== '' && SvgStyleSheet.attribute(element, name).includes(value);
      default:
        return null;
    }
  }

  private static pseudoTest(name: string, argument: string | undefined): { test: Test; specificity: number } | null {
    switch (name) {
      case 'root':
        return { test: (element) => element.parent === null, specificity: 0x100 };
      case 'first-child':
        return { test: (element) => element.parent?.children[0] === element, specificity: 0x100 };
      case 'last-child':
        return {
          test: (element) => {
            const siblings = element.parent?.children;
            return siblings !== undefined && siblings[siblings.length - 1] === element;
          },
          specificity: 0x100,
        };
      case 'not': {
        // One compound inside: `:not(.a)`, `:not([b])`.
        const inner = argument === undefined || /[\s>+~,]/.test(argument.trim()) ? null : SvgStyleSheet.selector(argument);
        if (!inner) {
          return null;
        }
        return { test: (element) => !SvgStyleSheet.matches(element, inner, 0), specificity: inner.specificity };
      }
      default:
        return null;
    }
  }

  /** Whether `element` is what the selector's compound `index` (0 is the rightmost) and all to its left ask for. */
  private static matches(element: XmlElement, selector: Selector, index: number): boolean {
    if (!selector.compounds[index].tests.every((test) => test(element))) {
      return false;
    }
    if (index === selector.compounds.length - 1) {
      return true;
    }
    const combinator = selector.combinators[index];
    switch (combinator) {
      case '>':
        return element.parent !== null && SvgStyleSheet.matches(element.parent, selector, index + 1);
      case ' ':
        for (let ancestor = element.parent; ancestor; ancestor = ancestor.parent) {
          if (SvgStyleSheet.matches(ancestor, selector, index + 1)) {
            return true;
          }
        }
        return false;
      case '+':
      case '~': {
        const siblings = element.parent?.children ?? [];
        const at = siblings.indexOf(element);
        for (let i = at - 1; i >= 0; i--) {
          if (SvgStyleSheet.matches(siblings[i], selector, index + 1)) {
            return true;
          }
          if (combinator === '+') {
            break;
          }
        }
        return false;
      }
      default:
        return false;
    }
  }

  /** Whether a value with weight `p` replaces one with weight `q`: the heavier wins, and of two equals the later. */
  private static outweighs(p: readonly number[], q: readonly number[]): boolean {
    for (let i = 0; i < p.length; i++) {
      if (p[i] !== q[i]) {
        return p[i] > q[i];
      }
    }
    return true;
  }
}
