// A small XML reader for the files an import takes — SVG today. Pure
// TypeScript, so a file is read the same way in the page, in the tests and
// on the command line, and nothing a file names is ever fetched.

export type XmlAttribute = {
  /** As written: `xlink:href`. */
  name: string;
  /** The namespace its prefix is bound to; empty for an attribute without a prefix. */
  namespace: string;
  /** The name without its prefix: `href`. */
  local: string;
  value: string;
};

export interface XmlElement {
  /** As written: `svg:path`. */
  name: string;
  /** The namespace the element is in; empty when the file declares none. */
  namespace: string;
  /** The name without its prefix: `path`. */
  local: string;
  attributes: XmlAttribute[];
  children: XmlElement[];
  parent: XmlElement | null;
  /** The element's own character data (text and CDATA sections), in order, without its children's. */
  text: string;
}

export interface XmlDocument {
  root: XmlElement;
  /** The comments before the root element: where a program says it wrote the file. */
  comments: string[];
}

/** The five entities every XML file has. */
const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Prefixes files use without declaring them; a strict reader refuses such a file, this one reads it. */
const WELL_KNOWN_PREFIXES: Record<string, string> = {
  xml: 'http://www.w3.org/XML/1998/namespace',
  svg: 'http://www.w3.org/2000/svg',
  xlink: 'http://www.w3.org/1999/xlink',
  inkscape: 'http://www.inkscape.org/namespaces/inkscape',
  sodipodi: 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
};

/** Elements nested deeper than this are refused: no drawing is, and a walk of the tree must not run out of stack. */
const MAX_DEPTH = 1000;

/** What the file's own entities may expand to in total, in characters: stops an entity that expands without end. */
const MAX_ENTITY_EXPANSION = 4 * 1024 * 1024;

/** How deep one entity may refer to another. */
const MAX_ENTITY_DEPTH = 16;

/**
 * XML text → a tree of elements with their namespaces resolved.
 *
 * What is read: elements and attributes (either quote), character data and
 * CDATA, comments, processing instructions, the XML declaration, character
 * references, and the entities a file declares in its own DOCTYPE — Adobe
 * Illustrator names its namespaces that way (`xmlns:x="&ns_extend;"`).
 * Nothing external is ever resolved: an entity that points at a file or a
 * URL expands to nothing.
 *
 * Structure is checked — a tag closed by another one, a file that ends
 * inside an element — because a file broken there is not the drawing its
 * author saw. The small things real files get wrong are let through: a
 * prefix that is never declared, an entity that is not defined (left as
 * written), an attribute without quotes.
 */
export class XmlParser {
  static parse(text: string): XmlDocument {
    return new XmlParser(text).document();
  }

  private readonly text: string;
  private at = 0;
  private readonly entities = new Map<string, string>();
  private expanded = 0;

  private constructor(text: string) {
    this.text = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  private document(): XmlDocument {
    const { text } = this;
    const comments: string[] = [];
    let root: XmlElement | null = null;
    let current: XmlElement | null = null;
    /** Prefix bindings in force for each open element, innermost last. */
    const scopes: Map<string, string>[] = [new Map()];
    let depth = 0;

    while (this.at < text.length) {
      const open = text.indexOf('<', this.at);
      const run = text.slice(this.at, open < 0 ? text.length : open);
      if (current) {
        if (run.length > 0) {
          current.text += this.decode(run);
        }
      } else if (!root && run.trim().length > 0) {
        throw this.error('it does not start with an XML element', this.at);
      }
      if (open < 0) {
        break;
      }
      this.at = open;

      if (text.startsWith('<!--', open)) {
        const end = text.indexOf('-->', open + 4);
        if (end < 0) {
          throw this.error('a comment is never closed', open);
        }
        if (!root) {
          comments.push(text.slice(open + 4, end).trim());
        }
        this.at = end + 3;
      } else if (text.startsWith('<![CDATA[', open)) {
        const end = text.indexOf(']]>', open + 9);
        if (end < 0) {
          throw this.error('a CDATA section is never closed', open);
        }
        if (current) {
          current.text += text.slice(open + 9, end);
        }
        this.at = end + 3;
      } else if (text.startsWith('<?', open)) {
        const end = text.indexOf('?>', open + 2);
        if (end < 0) {
          throw this.error('a processing instruction is never closed', open);
        }
        this.at = end + 2;
      } else if (text.startsWith('<!', open)) {
        this.doctype();
      } else if (text.startsWith('</', open)) {
        const end = text.indexOf('>', open + 2);
        if (end < 0) {
          throw this.error('a closing tag is never finished', open);
        }
        const name = text.slice(open + 2, end).trim();
        if (!current) {
          if (root) {
            // Past the root: nothing there is part of the document.
            break;
          }
          throw this.error(`</${name}> closes nothing`, open);
        }
        if (current.name !== name) {
          throw this.error(`</${name}> closes <${current.name}>`, open);
        }
        current = current.parent;
        scopes.pop();
        depth--;
        this.at = end + 1;
        if (!current) {
          break;
        }
      } else {
        if (root && !current) {
          // A second element after the root: not part of the document.
          break;
        }
        const tag = this.startTag();
        const scope = XmlParser.scope(scopes[scopes.length - 1], tag.attributes);
        const element = XmlParser.element(tag.name, tag.attributes, scope, current);
        if (current) {
          current.children.push(element);
        } else {
          root = element;
        }
        if (!tag.selfClosing) {
          if (++depth > MAX_DEPTH) {
            throw this.error(`its elements are nested more than ${MAX_DEPTH} deep`, open);
          }
          current = element;
          scopes.push(scope);
        }
      }
    }

    if (current) {
      throw this.error(`it ends inside <${current.name}>`, text.length);
    }
    if (!root) {
      throw this.error('it has no elements', 0);
    }
    return { root, comments };
  }

  // ─── Tags ───────────────────────────────────────────────────────────────

  /** A start tag from its `<`: the name and the attributes as written, values decoded. */
  private startTag(): { name: string; attributes: { name: string; value: string }[]; selfClosing: boolean } {
    const { text } = this;
    const from = this.at;
    let i = from + 1;
    const nameEnd = XmlParser.nameEnd(text, i);
    const name = text.slice(i, nameEnd);
    if (name.length === 0) {
      throw this.error('a tag has no name', from);
    }
    i = nameEnd;
    const attributes: { name: string; value: string }[] = [];
    for (;;) {
      i = XmlParser.skipSpace(text, i);
      if (i >= text.length) {
        throw this.error(`the tag <${name}> is never finished`, from);
      }
      if (text[i] === '>') {
        this.at = i + 1;
        return { name, attributes, selfClosing: false };
      }
      if (text[i] === '/') {
        const close = XmlParser.skipSpace(text, i + 1);
        if (text[close] !== '>') {
          throw this.error(`the tag <${name}> is never finished`, from);
        }
        this.at = close + 1;
        return { name, attributes, selfClosing: true };
      }
      const attributeEnd = XmlParser.nameEnd(text, i);
      const attribute = text.slice(i, attributeEnd);
      if (attribute.length === 0) {
        throw this.error(`the tag <${name}> has a stray ${JSON.stringify(text[i])}`, i);
      }
      i = XmlParser.skipSpace(text, attributeEnd);
      if (text[i] !== '=') {
        // A bare attribute, as in HTML: present, with no value.
        attributes.push({ name: attribute, value: '' });
        continue;
      }
      i = XmlParser.skipSpace(text, i + 1);
      const quote = text[i];
      let raw: string;
      if (quote === '"' || quote === "'") {
        const end = text.indexOf(quote, i + 1);
        if (end < 0) {
          throw this.error(`the attribute ${attribute} of <${name}> is never closed`, i);
        }
        raw = text.slice(i + 1, end);
        i = end + 1;
      } else {
        const end = XmlParser.nameEnd(text, i);
        raw = text.slice(i, end);
        i = end;
      }
      // Line ends and tabs in a value are spaces, as the format normalises them.
      attributes.push({ name: attribute, value: this.decode(raw.replace(/[\t\r\n]/g, ' ')) });
    }
  }

  /** Where a name that starts at `i` ends: at white space or a delimiter. */
  private static nameEnd(text: string, i: number): number {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      // space, tab, LF, CR, '/', '=', '>', '<', quotes
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47 || c === 61 || c === 62 || c === 60 || c === 34 || c === 39) {
        break;
      }
      i++;
    }
    return i;
  }

  private static skipSpace(text: string, i: number): number {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) {
        break;
      }
      i++;
    }
    return i;
  }

  // ─── Namespaces ─────────────────────────────────────────────────────────

  /** The prefix bindings inside an element: its parent's, with the ones it declares itself. */
  private static scope(parent: Map<string, string>, attributes: readonly { name: string; value: string }[]): Map<string, string> {
    let scope = parent;
    for (const attribute of attributes) {
      if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) {
        if (scope === parent) {
          scope = new Map(parent);
        }
        scope.set(attribute.name === 'xmlns' ? '' : attribute.name.slice(6), attribute.value);
      }
    }
    return scope;
  }

  private static element(
    name: string,
    attributes: readonly { name: string; value: string }[],
    scope: Map<string, string>,
    parent: XmlElement | null,
  ): XmlElement {
    const resolve = (prefix: string) => scope.get(prefix) ?? WELL_KNOWN_PREFIXES[prefix] ?? '';
    const colon = name.indexOf(':');
    const element: XmlElement = {
      name,
      namespace: colon < 0 ? scope.get('') ?? '' : resolve(name.slice(0, colon)),
      local: colon < 0 ? name : name.slice(colon + 1),
      attributes: [],
      children: [],
      parent,
      text: '',
    };
    for (const attribute of attributes) {
      if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) {
        continue;
      }
      const at = attribute.name.indexOf(':');
      element.attributes.push({
        name: attribute.name,
        // An attribute without a prefix is in no namespace, whatever its element's default is.
        namespace: at < 0 ? '' : resolve(attribute.name.slice(0, at)),
        local: at < 0 ? attribute.name : attribute.name.slice(at + 1),
        value: attribute.value,
      });
    }
    return element;
  }

  // ─── Entities ───────────────────────────────────────────────────────────

  /**
   * A `<!DOCTYPE …>` from its `<!`, with the entities its internal subset
   * declares as literal text. External ones (`SYSTEM`, `PUBLIC`) and
   * parameter entities are passed over.
   */
  private doctype(): void {
    const { text } = this;
    const from = this.at;
    let i = from + 2;
    let subset: [number, number] | null = null;
    let quote = '';
    let depth = 0;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote) {
          quote = '';
        }
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '[') {
        if (depth++ === 0) {
          subset = [i + 1, i + 1];
        }
      } else if (c === ']') {
        if (--depth === 0 && subset) {
          subset[1] = i;
        }
      } else if (c === '>' && depth <= 0) {
        break;
      }
    }
    if (i >= text.length) {
      throw this.error('its DOCTYPE is never closed', from);
    }
    this.at = i + 1;
    if (!subset) {
      return;
    }
    const declaration = /<!ENTITY\s+([^\s%"'<>]+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g;
    const body = text.slice(subset[0], subset[1]);
    for (let match = declaration.exec(body); match; match = declaration.exec(body)) {
      // The first declaration of a name is the one that counts.
      if (!this.entities.has(match[1])) {
        this.entities.set(match[1], match[2] ?? match[3] ?? '');
      }
    }
  }

  /** Character data or an attribute value with its references replaced. */
  private decode(raw: string, depth = 0): string {
    if (!raw.includes('&')) {
      return raw;
    }
    return raw.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[^\s&;]+);/g, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        // Outside Unicode, or a lone surrogate half: not a character.
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
      }
      if (name in PREDEFINED) {
        return PREDEFINED[name];
      }
      const value = this.entities.get(name);
      if (value === undefined) {
        // Not defined: a strict reader stops here; the text is kept as written.
        return whole;
      }
      if (depth >= MAX_ENTITY_DEPTH) {
        throw this.error('its entities refer to each other without end', this.at);
      }
      const expansion = this.decode(value, depth + 1);
      this.expanded += expansion.length;
      if (this.expanded > MAX_ENTITY_EXPANSION) {
        throw this.error('its entities expand without end', this.at);
      }
      return expansion;
    });
  }

  // ─── Errors ─────────────────────────────────────────────────────────────

  private error(what: string, at: number): Error {
    let line = 1;
    for (let i = 0; i < at && i < this.text.length; i++) {
      if (this.text.charCodeAt(i) === 10) {
        line++;
      }
    }
    return new Error(`The file is not well-formed XML: ${what} (line ${line}).`);
  }
}
