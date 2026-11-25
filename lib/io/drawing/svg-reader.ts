import type { Curve2D } from "./drawing.js";
import { Affine, type Affine2 } from "./affine.js";
import type { ImportedConstructionLine, ImportedDrawing, ImportedEntity, ImportedLayer, ImportedUnit } from "./import.js";
import { ImportedDrawings } from "./import.js";
import { PathSegments, type PathSegment, type Subpath } from "./path-segments.js";
import { SvgPathData } from "./svg-path.js";
import { SvgStyleSheet } from "./svg-style.js";
import { SvgGuides } from "./svg-guides.js";
import { SvgText } from "./svg-text.js";
import type { ImportedText } from "./imported-text.js";
import { SvgValues } from "./svg-values.js";
import { XmlParser, type XmlDocument, type XmlElement } from "./xml.js";

export interface SvgReadOptions {
  /**
   * Read a cubic bezier that follows a circle as the arc it stands for
   * (see `PathSegments.arcOf`). On unless set to false.
   */
  arcs?: boolean;
  /**
   * Also read the shapes the file draws with neither a fill nor a stroke,
   * or makes invisible. Off unless set: what nobody saw in the drawing is
   * usually a bounding box or a guide.
   */
  unpainted?: boolean;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';
const INKSCAPE_NAMESPACE = 'http://www.inkscape.org/namespaces/inkscape';

const MM_PER_INCH = 25.4;

/** User units to the inch, as CSS has them. */
const CSS_PER_INCH = 96;
/** Inkscape before 0.92 had 90. */
const OLD_INKSCAPE_PER_INCH = 90;
/** Adobe Illustrator writes points and calls them pixels. */
const ILLUSTRATOR_PER_INCH = 72;

/** The layer of what the file draws outside any layer. */
const NO_LAYER = '(no layer)';

/** A file that draws more curves than this once its references are followed is refused: no sketch could take it. */
const MAX_ENTITIES = 200_000;

/** Elements visited while following references before the reader gives up: a file may refer to itself a billion times over in a few lines. */
const MAX_VISITS = 2_000_000;

/** How deep a reference may lead to another. */
const MAX_USE_DEPTH = 32;

/** Tolerances are this share of a curve's own size: the file's unit is not known while it is read. */
const RELATIVE_TOLERANCE = 1e-9;

/** The elements that draw, or hold what draws. */
const DRAWN = new Set(['svg', 'g', 'a', 'switch', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

/** The elements that draw something that is not a curve nor text, by the name they are counted under. */
const NOT_CURVES: Record<string, string> = { image: 'image', foreignObject: 'embedded object' };

/** One text read, with what decides whether it counts. */
type EmittedText = { text: ImportedText; hidden: boolean; painted: boolean };

/** Units a page size is physical in: a length in one of them says how large the drawing is. */
const PHYSICAL_UNITS = new Set(['mm', 'cm', 'in', 'pt', 'pc', 'q']);

/** The lengths a file's unit may come out as, by name. */
const UNIT_NAMES: [number, string][] = [
  [1, 'mm'],
  [10, 'cm'],
  [1000, 'm'],
  [MM_PER_INCH, 'in'],
  [304.8, 'ft'],
  [MM_PER_INCH / CSS_PER_INCH, 'px'],
  [MM_PER_INCH / ILLUSTRATOR_PER_INCH, 'pt'],
  [MM_PER_INCH / 6, 'pc'],
  [MM_PER_INCH / OLD_INKSCAPE_PER_INCH, 'px at 90 per inch'],
];

/** One curve read, before the file's own view of what counts is applied. */
type Emitted = {
  /** Null outside any layer. */
  layer: string | null;
  /** On a layer the file has switched off. */
  hidden: boolean;
  curve: Curve2D;
  /** Drawn with a fill or a stroke: something its author could see. */
  painted: boolean;
};

/** What the reader notes on the way, for the warnings. */
type Tally = {
  skipped: Record<string, number>;
  /** Shapes with neither fill nor stroke, or made invisible. */
  unpainted: number;
  /** Shapes under a clip path or a mask. */
  clipped: number;
  transformErrors: number;
  pathErrors: number;
  /** Beziers read as arcs, on shapes that are painted and on those that are not. */
  recognized: number;
  recognizedUnpainted: number;
  missing: Set<string>;
  external: number;
  circular: boolean;
  percentWithoutPage: boolean;
};

/** The size percentages are of: the nearest viewport's, in its own user units. */
type Viewport = { width: number; height: number; known: boolean };

/** What an element is drawn in: everything it takes from where it stands in the document. */
type Context = {
  /** The element's parent's coordinates → the drawing's. */
  m: Affine2;
  viewport: Viewport;
  // Inherited properties, as the cascade leaves them.
  fill: string;
  fillOpacity: string;
  stroke: string;
  strokeOpacity: string;
  strokeWidth: string;
  visibility: string;
  /** Under an element of no opacity. */
  transparent: boolean;
  /** Under a clip path or a mask. */
  clipped: boolean;
  layer: string | null;
  hidden: boolean;
  /** The references being followed, outermost first. */
  uses: XmlElement[];
  out: Emitted[];
  tally: Tally;
  /** The element whose own transform is left out: the one being measured for its bounding box. */
  bare: XmlElement | null;
};

/**
 * An SVG as the curves it draws, in the drawing model the writers share.
 * Written for the files people bring to a sketch — a logo, an outline from
 * a drawing program, a laser profile, an icon — from any program that
 * writes the format, and lenient where real files are loose.
 *
 * **Flattened.** An SVG is a tree: groups inside groups, each with its own
 * transform, symbols drawn again by reference, a page that scales what is
 * on it. What comes out has none of that: every curve is in one coordinate
 * system, with every transform between it and the page worked into its
 * numbers. That covers `transform` on any element — `matrix`, `translate`,
 * `scale`, `rotate` (about a point too), `skewX`, `skewY`, in any order and
 * nested to any depth, with `transform-origin` — the `viewBox` and
 * `preserveAspectRatio` of the root and of an `<svg>` inside it, the `x`
 * and `y` of a `<use>` and the viewport of the `<symbol>` it draws.
 * A circle under a scale along one axis is the ellipse it becomes; an arc
 * under a mirror is the arc that turns the other way.
 *
 * **What is read:** `<path>` (the whole grammar: lines, cubic and quadratic
 * béziers, elliptical arcs, relative and shorthand forms), `<rect>` (with
 * rounded corners), `<circle>`, `<ellipse>`, `<line>`, `<polyline>`,
 * `<polygon>`, and what `<g>`, `<a>`, `<switch>`, `<svg>` and `<use>` hold
 * or refer to. Lengths are taken with their units and percentages.
 *
 * **What a style says** is followed where it decides what is drawn:
 * `display: none` leaves an element out, a shape with neither fill nor
 * stroke is one its author never saw and is left out too, and `<style>`
 * sheets are applied (see `SvgStyleSheet`) since that is where many
 * programs put all of it.
 *
 * **Circles.** A path cannot say "circle": it draws one as two arcs or as
 * four béziers. Runs of arcs on one circle are read as that one arc or
 * circle, and a bezier that follows a circle as its arc (`PathSegments`).
 *
 * **Guides.** The guides an Inkscape file keeps beside its drawing are read
 * as construction lines (see `SvgGuides`); whoever imports decides whether
 * they come in.
 *
 * **Text.** A `<text>` is read as text (see `SvgText`), apart from the
 * curves; whoever imports decides whether it comes in.
 *
 * **Left out:** images and embedded objects, counted in `skipped`;
 * clip paths and masks, whose shapes come in whole, with a warning; fills,
 * strokes' widths, markers, patterns and filters, which are not curves.
 *
 * **Coordinates.** SVG's Y runs down the page, a drawing's up. The page is
 * turned over so it reads the same: its lower-left corner is the origin,
 * and the drawing lies above and to the right of it. Lengths are in the
 * page's own user units — the view box's — and `unit` says how long one is
 * from the size the file gives its page. A file with no size at all says
 * nothing about its unit.
 */
export class SvgReader {
  static read(text: string, options: SvgReadOptions = {}): ImportedDrawing {
    const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    if (!/^\s*</.test(text.slice(start, start + 4096))) {
      throw new Error('This is not an SVG file: it does not start with an XML element.');
    }
    const document = XmlParser.parse(text);
    const root = document.root;
    if (root.local !== 'svg' || (root.namespace !== SVG_NAMESPACE && root.namespace !== '')) {
      throw new Error(`This is not an SVG file: its outermost element is <${root.name}>.`);
    }
    const reader = new SvgReader(document, options);
    reader.load();
    return reader.result();
  }

  /** {@link read} for a file's bytes, decoded as {@link decode} decodes them. */
  static readBytes(bytes: Uint8Array, options: SvgReadOptions = {}): ImportedDrawing {
    return SvgReader.read(SvgReader.decode(bytes), options);
  }

  /**
   * A file's bytes as text: UTF-8 unless a byte-order mark says UTF-16, or
   * the bytes are not valid UTF-8 — then the encoding the XML declaration
   * names, Western European when it names none.
   */
  static decode(bytes: Uint8Array): string {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      throw new Error('This is a compressed SVG (.svgz). Save the drawing as a plain SVG and import that.');
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes);
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // Not UTF-8: what the declaration says.
    }
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
    const named = /<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1];
    try {
      return new TextDecoder(named && !/^utf-?8$/i.test(named) ? named : 'windows-1252').decode(bytes);
    } catch {
      // A runtime without that encoding: the numbers still read.
      return new TextDecoder('latin1').decode(bytes);
    }
  }

  private readonly document: XmlDocument;
  private readonly arcs: boolean;
  private readonly unpainted: boolean;
  /** The namespace the file's SVG elements are in: SVG's, or none at all for a file that forgot to declare it. */
  private readonly namespace: string;
  private readonly ids = new Map<string, XmlElement>();
  private readonly sheet: SvgStyleSheet;
  /** The file marks its layers the way Inkscape does. */
  private readonly inkscapeLayers: boolean;
  private readonly emitted: Emitted[] = [];
  private readonly tally: Tally = SvgReader.newTally();
  private readonly notes: string[] = [];
  /** User units per absolute unit: what `1mm` is in the file's coordinates. */
  private units: Record<string, number> = SvgValues.unitFactors(CSS_PER_INCH);
  private unit: ImportedUnit | null = null;
  private guides: ImportedConstructionLine[] = [];
  private readonly texts: EmittedText[] = [];
  private visits = 0;

  private constructor(document: XmlDocument, options: SvgReadOptions) {
    this.document = document;
    this.arcs = options.arcs !== false;
    this.unpainted = options.unpainted === true;
    this.namespace = document.root.namespace;

    // One pass over the whole tree: what can be referred to, the style sheets, and how layers are marked.
    const sheets: string[] = [];
    let inkscapeLayers = false;
    const stack: XmlElement[] = [document.root];
    while (stack.length > 0) {
      const element = stack.pop()!;
      if (element.namespace === this.namespace) {
        const id = SvgReader.attribute(element, 'id');
        if (id !== undefined && !this.ids.has(id)) {
          this.ids.set(id, element);
        }
        if (element.local === 'style') {
          const type = SvgReader.attribute(element, 'type');
          if (type === undefined || type.trim() === '' || /^text\/css\b/i.test(type.trim())) {
            sheets.push(element.text);
          }
        } else if (element.local === 'g' && SvgReader.attribute(element, 'groupmode', INKSCAPE_NAMESPACE) === 'layer') {
          inkscapeLayers = true;
        }
      }
      for (let i = element.children.length - 1; i >= 0; i--) {
        stack.push(element.children[i]);
      }
    }
    this.sheet = new SvgStyleSheet(sheets);
    this.inkscapeLayers = inkscapeLayers;
  }

  // ─── The page ───────────────────────────────────────────────────────────

  /**
   * The root: how large the page is, how its view box lies on it, what one
   * unit of it measures — and from there, everything it holds.
   */
  private load(): void {
    const root = this.document.root;
    const declared = this.sheet.declared(root);
    const box = SvgValues.viewBox(SvgReader.attribute(root, 'viewBox'));
    const widthText = SvgValues.length(declared.get('width'));
    const heightText = SvgValues.length(declared.get('height'));
    const physical = (widthText !== null && PHYSICAL_UNITS.has(widthText.unit))
      || (heightText !== null && PHYSICAL_UNITS.has(heightText.unit));

    // Two programs do not count 96 units to the inch, and their files do not say so.
    let perInch = CSS_PER_INCH;
    const inkscape = /^\s*(\d+)\.(\d+)/.exec(SvgReader.attribute(root, 'version', INKSCAPE_NAMESPACE) ?? '');
    if (inkscape && !box && (Number(inkscape[1]) === 0 && Number(inkscape[2].slice(0, 2).padEnd(2, '0')) < 92)) {
      perInch = OLD_INKSCAPE_PER_INCH;
      this.notes.push('The file was made with Inkscape before 0.92, which counted 90 units to the inch: it is read that way.');
    } else if (!physical && this.document.comments.some((comment) => /Generator:\s*Adobe Illustrator/i.test(comment))) {
      perInch = ILLUSTRATOR_PER_INCH;
      this.notes.push('The file was written by Adobe Illustrator, which counts 72 units to the inch: it is read that way. Pick another file unit if it comes out the wrong size.');
    }
    this.units = SvgValues.unitFactors(perInch);

    const size = (length: { value: number; unit: string } | null): number | null => {
      const factor = length ? this.units[length.unit] : undefined;
      return length && factor !== undefined && length.value > 0 ? length.value * factor : null;
    };
    let width = size(widthText);
    let height = size(heightText);
    const sized = width !== null || height !== null || perInch !== CSS_PER_INCH;
    if (box) {
      // A missing side follows from the other and the box's proportions; with neither, the box is the page.
      if (width === null && height === null) {
        width = box.width;
        height = box.height;
      } else if (width === null) {
        width = (height! * box.width) / box.height;
      } else if (height === null) {
        height = (width * box.height) / box.width;
      }
    }

    const viewport: Viewport = box
      ? { width: box.width, height: box.height, known: true }
      : { width: width ?? 0, height: height ?? 0, known: width !== null && height !== null };

    // User units → the page, measured down from its upper-left corner in the
    // drawing's own units; `scale` is how many page pixels one of them is.
    let toPage = Affine.IDENTITY;
    let scale = 1;
    let pageWidth = width ?? 0;
    let pageHeight = height ?? 0;
    // Nothing but the view box's corner lies between user units and the page:
    // the box fills the page with one scale both ways, and the page is not turned.
    let plain = true;
    if (box && width !== null && height !== null) {
      const aspect = SvgValues.aspect(SvgReader.attribute(root, 'preserveAspectRatio'));
      const ratioX = width / box.width;
      const ratioY = height / box.height;
      plain = aspect.uniform && Math.abs(ratioX - ratioY) <= Math.max(ratioX, ratioY) * 1e-9;
      if (aspect.uniform) {
        // One scale for both axes, so the view box's numbers stay as they
        // are: the page is the box, with room to spare (or cut off) along
        // the axis that did not set the scale.
        const byWidth = aspect.slice ? ratioX >= ratioY : ratioX <= ratioY;
        scale = byWidth ? ratioX : ratioY;
        pageWidth = byWidth ? box.width : width / scale;
        pageHeight = byWidth ? height / scale : box.height;
        toPage = Affine.translation({
          x: -box.x + (pageWidth - box.width) * aspect.alignX,
          y: -box.y + (pageHeight - box.height) * aspect.alignY,
        });
      } else {
        toPage = SvgValues.viewportTransform(box, aspect, width, height);
        this.notes.push('The file stretches its drawing to fill the page (preserveAspectRatio="none"): it is read as stretched, in page pixels.');
      }
    }

    // A transform on the root turns the whole page, about its middle.
    const turned = declared.get('transform');
    if (turned !== undefined) {
      const m = SvgValues.transform(turned, this.units);
      if (!m) {
        this.tally.transformErrors++;
      } else if (!Affine.isIdentity(m)) {
        plain = false;
        const about = { x: pageWidth / 2, y: pageHeight / 2 };
        toPage = Affine.compose(toPage, Affine.compose(
          Affine.translation({ x: -about.x, y: -about.y }),
          Affine.compose({ ...m, e: m.e / scale, f: m.f / scale }, Affine.translation(about)),
        ));
      }
    }

    // Turned over: up the page is up the drawing, from the page's lower edge when it has one.
    const out = Affine.compose(toPage, { a: 1, b: 0, c: 0, d: -1, e: 0, f: pageHeight });
    this.unit = sized ? SvgReader.unitOf((MM_PER_INCH / perInch) * scale) : null;

    // A guide gives its place from the page's lower-left corner in user
    // units: the drawing's own frame on a plain page that has a height.
    const guides = SvgGuides.read(root, {
      inkscapeVersion: SvgReader.attribute(root, 'version', INKSCAPE_NAMESPACE),
      plain: plain && pageHeight > 0,
    });
    this.guides = guides.lines.map((line) => ({ layer: null, ...line }));
    if (guides.unread > 0) {
      this.tally.skipped.guide = (this.tally.skipped.guide ?? 0) + guides.unread;
      this.notes.push(`${guides.unread === 1 ? 'A guide was' : `${guides.unread} guides were`} left out: ${guides.reason}.`);
    }

    const context = this.derive({
      m: out,
      viewport,
      fill: 'black',
      fillOpacity: '1',
      stroke: 'none',
      strokeOpacity: '1',
      strokeWidth: '1',
      visibility: 'visible',
      transparent: false,
      clipped: false,
      layer: null,
      hidden: false,
      uses: [],
      out: this.emitted,
      tally: this.tally,
      bare: null,
    }, declared);
    for (const child of root.children) {
      this.enter(child, context);
    }
  }

  /** A unit of `mm` millimetres by name — "mm", "px", … — or, when it is none of those, by its length: "0.1 mm". */
  private static unitOf(mm: number): ImportedUnit {
    for (const [length, name] of UNIT_NAMES) {
      // The length itself, not what the arithmetic left of it.
      if (Math.abs(mm - length) <= length * 1e-9) {
        return { name, mm: length };
      }
    }
    const rounded = Number(mm.toPrecision(12));
    return { name: `${Number(mm.toPrecision(6))} mm`, mm: rounded };
  }

  // ─── The tree ───────────────────────────────────────────────────────────

  /** One element in the context of where it is drawn: its curves, or its children's. */
  private enter(element: XmlElement, ctx: Context): void {
    if (element.namespace !== this.namespace) {
      return;
    }
    const local = element.local;
    const counted = NOT_CURVES[local];
    if (!DRAWN.has(local) && counted === undefined && local !== 'text') {
      // Definitions, paint servers, metadata, and elements this does not know: nothing drawn here.
      return;
    }
    if (++this.visits > MAX_VISITS) {
      throw new Error('The drawing refers to its own parts too many times over to be read.');
    }
    // An element that asks for an extension is for a program that has it.
    if (SvgReader.attribute(element, 'requiredExtensions') !== undefined || SvgReader.attribute(element, 'systemLanguage')?.trim() === '') {
      return;
    }
    const declared = this.sheet.declared(element);

    let layer = ctx.layer;
    let hidden = ctx.hidden;
    let isLayer = false;
    if (local === 'g' && ctx.uses.length === 0) {
      const name = this.layerName(element);
      // Inkscape's layers nest, the innermost counting; a named group is a layer when no layer holds it.
      if (name !== null && (this.inkscapeLayers || layer === null)) {
        layer = name;
        isLayer = true;
      }
    }
    if (declared.get('display')?.toLowerCase() === 'none') {
      if (!isLayer) {
        return;
      }
      // A layer switched off is still read: whoever imports decides.
      hidden = true;
    }
    if (counted !== undefined) {
      ctx.tally.skipped[counted] = (ctx.tally.skipped[counted] ?? 0) + 1;
      return;
    }

    const inner = this.derive(ctx, declared);
    inner.layer = layer;
    inner.hidden = hidden;
    const transform = this.transformOf(element, declared, ctx);

    switch (local) {
      case 'text':
        // Not while an element is only being measured for its bounding box.
        if (ctx.out === this.emitted) {
          const read = SvgText.read(element, this.lineage(element, ctx), Affine.compose(transform, ctx.m), layer, {
            declared: (of) => this.sheet.declared(of),
            units: this.units,
            namespace: this.namespace,
          });
          const painted = SvgReader.isPainted(inner, false);
          for (const text of read) {
            this.texts.push({ text, hidden, painted });
          }
        }
        break;
      case 'g':
      case 'a':
        inner.m = Affine.compose(transform, ctx.m);
        for (const child of element.children) {
          this.enter(child, inner);
        }
        break;
      case 'switch': {
        // The first child whose conditions hold, and no other.
        inner.m = Affine.compose(transform, ctx.m);
        const chosen = element.children.find((child) => child.namespace === this.namespace
          && SvgReader.attribute(child, 'requiredExtensions') === undefined
          && SvgReader.attribute(child, 'systemLanguage')?.trim() !== '');
        if (chosen) {
          this.enter(chosen, inner);
        }
        break;
      }
      case 'svg':
        this.viewport(element, inner, transform, null, null);
        break;
      case 'use':
        this.use(element, inner, transform);
        break;
      default: {
        inner.m = Affine.compose(transform, ctx.m);
        const subpaths = this.shape(element, declared, inner);
        if (subpaths) {
          this.emit(subpaths, inner, local === 'line');
        }
      }
    }
  }

  /**
   * The elements `element` inherits its properties from, outermost first.
   * What a `<use>` draws inherits from the reference, not from where it is
   * defined: at the element a reference names, the way up goes on from the
   * reference.
   */
  private lineage(element: XmlElement, ctx: Context): XmlElement[] {
    const lineage: XmlElement[] = [];
    let uses = ctx.uses.length;
    let at: XmlElement | null = element;
    while (at) {
      const use: XmlElement | undefined = uses > 0 ? ctx.uses[uses - 1] : undefined;
      const href = use ? (SvgReader.attribute(use, 'href') ?? SvgReader.attribute(use, 'href', XLINK_NAMESPACE))?.trim() : undefined;
      if (use && href !== undefined && this.ids.get(href.slice(1)) === at) {
        uses--;
        at = use;
      } else {
        at = at.parent;
      }
      if (at) {
        lineage.unshift(at);
      }
    }
    return lineage;
  }

  /** The context for what an element holds: its parent's, with what the element declares for itself. */
  private derive(ctx: Context, declared: ReadonlyMap<string, string>): Context {
    const inherit = (name: string, held: string): string => {
      const value = declared.get(name)?.toLowerCase();
      return value === undefined || value === 'inherit' ? held : value;
    };
    const set = (name: string): boolean => {
      const value = declared.get(name)?.toLowerCase();
      return value !== undefined && value !== 'none';
    };
    return {
      ...ctx,
      fill: inherit('fill', ctx.fill),
      fillOpacity: inherit('fill-opacity', ctx.fillOpacity),
      stroke: inherit('stroke', ctx.stroke),
      strokeOpacity: inherit('stroke-opacity', ctx.strokeOpacity),
      strokeWidth: inherit('stroke-width', ctx.strokeWidth),
      visibility: inherit('visibility', ctx.visibility),
      transparent: ctx.transparent || SvgReader.isZero(declared.get('opacity')),
      clipped: ctx.clipped || set('clip-path') || set('mask'),
    };
  }

  /**
   * The layer a group is, by name; null when it is none. Inkscape marks its
   * layers; in a file from another program a group that has a name is one —
   * Illustrator, Affinity and Figma write a document's layers as its named
   * top groups.
   */
  private layerName(element: XmlElement): string | null {
    const id = SvgReader.attribute(element, 'id');
    if (this.inkscapeLayers) {
      return SvgReader.attribute(element, 'groupmode', INKSCAPE_NAMESPACE) === 'layer'
        ? SvgReader.attribute(element, 'label', INKSCAPE_NAMESPACE) ?? id ?? 'Layer'
        : null;
    }
    const name = SvgReader.attribute(element, 'data-name')
      ?? element.attributes.find((attribute) => attribute.name === 'serif:id')?.value
      ?? SvgReader.attribute(element, 'label', INKSCAPE_NAMESPACE)
      // Illustrator spells what an id cannot hold as `_x2F_`.
      ?? id?.replace(/_x([0-9A-Fa-f]{2,4})_/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
    return name !== undefined && name.trim() !== '' ? name.trim() : null;
  }

  // ─── Transforms ─────────────────────────────────────────────────────────

  /** The element's own transform: its coordinates → its parent's. */
  private transformOf(element: XmlElement, declared: ReadonlyMap<string, string>, ctx: Context): Affine2 {
    const text = declared.get('transform');
    if (text === undefined || ctx.bare === element) {
      return Affine.IDENTITY;
    }
    const m = SvgValues.transform(text, this.units);
    if (!m) {
      ctx.tally.transformErrors++;
      return Affine.IDENTITY;
    }
    const origin = declared.get('transform-origin');
    if (origin === undefined || Affine.isIdentity(m)) {
      return m;
    }
    const about = this.origin(origin, declared.get('transform-box'), element, ctx);
    if (about.x === 0 && about.y === 0) {
      return m;
    }
    // About a point: there, transformed, and back.
    return Affine.compose(
      Affine.translation({ x: -about.x, y: -about.y }),
      Affine.compose(m, Affine.translation(about)),
    );
  }

  /**
   * A `transform-origin` as a point. Keywords and percentages are of a
   * reference box: the nearest viewport (at the origin, the view box's
   * size) unless `transform-box` names the element's own bounding box.
   */
  private origin(text: string, boxName: string | undefined, element: XmlElement, ctx: Context): { x: number; y: number } {
    let box = { x: 0, y: 0, width: ctx.viewport.width, height: ctx.viewport.height };
    if (boxName !== undefined && /^(fill|stroke|content|border)-box$/i.test(boxName.trim())) {
      box = this.bounds(element, ctx) ?? { x: 0, y: 0, width: 0, height: 0 };
    }
    const parts = text.trim().toLowerCase().split(/\s+/);
    let horizontal = parts[0] ?? 'center';
    let vertical = parts[1] ?? 'center';
    // The two may come in either order when a keyword says which is which.
    if (horizontal === 'top' || horizontal === 'bottom' || vertical === 'left' || vertical === 'right') {
      [horizontal, vertical] = [vertical, horizontal];
    }
    const along = (part: string, from: number, extent: number): number => {
      const share = ({ left: 0, top: 0, center: 0.5, right: 1, bottom: 1 } as Record<string, number>)[part];
      if (share !== undefined) {
        return from + share * extent;
      }
      const length = SvgValues.length(part);
      if (!length) {
        return from;
      }
      if (length.unit === '%') {
        return from + (length.value / 100) * extent;
      }
      return from + length.value * (this.units[length.unit] ?? 1);
    };
    return { x: along(horizontal, box.x, box.width), y: along(vertical, box.y, box.height) };
  }

  /** The bounding box of what an element draws, in its own coordinates; null when it draws nothing. */
  private bounds(element: XmlElement, ctx: Context): { x: number; y: number; width: number; height: number } | null {
    const out: Emitted[] = [];
    this.enter(element, { ...ctx, m: Affine.IDENTITY, out, tally: SvgReader.newTally(), bare: element });
    const box = ImportedDrawings.bounds(out.map((emitted) => emitted.curve));
    return box ? { x: box.min.x, y: box.min.y, width: box.max.x - box.min.x, height: box.max.y - box.min.y } : null;
  }

  // ─── Viewports and references ───────────────────────────────────────────

  /**
   * An `<svg>` inside the drawing, or a `<symbol>` being drawn: a viewport
   * of its own at `x`, `y`, `width` by `height`, with its view box fitted
   * into it. `ctx` is the element's own (its `m` still its parent's);
   * `width` and `height` are given when a `<use>` sets them.
   */
  private viewport(element: XmlElement, ctx: Context, transform: Affine2, width: number | null, height: number | null): void {
    const x = this.length(SvgReader.attribute(element, 'x'), 'x', ctx) ?? 0;
    const y = this.length(SvgReader.attribute(element, 'y'), 'y', ctx) ?? 0;
    // Without a size of its own it takes the whole of the viewport it is in.
    const w = width ?? this.length(SvgReader.attribute(element, 'width'), 'x', ctx) ?? (ctx.viewport.known ? ctx.viewport.width : null);
    const h = height ?? this.length(SvgReader.attribute(element, 'height'), 'y', ctx) ?? (ctx.viewport.known ? ctx.viewport.height : null);
    const box = SvgValues.viewBox(SvgReader.attribute(element, 'viewBox'));
    let inside = Affine.IDENTITY;
    let viewport: Viewport = { width: w ?? 0, height: h ?? 0, known: w !== null && h !== null };
    if (w !== null && h !== null) {
      if (!(w > 0) || !(h > 0)) {
        // A viewport with no area draws nothing.
        return;
      }
      if (box) {
        inside = SvgValues.viewportTransform(box, SvgValues.aspect(SvgReader.attribute(element, 'preserveAspectRatio')), w, h);
        viewport = { width: box.width, height: box.height, known: true };
      }
    } else {
      ctx.tally.percentWithoutPage = true;
    }
    if (element.local === 'symbol') {
      // The symbol's reference point is what lands on its position.
      const refX = SvgValues.number(SvgReader.attribute(element, 'refX'));
      const refY = SvgValues.number(SvgReader.attribute(element, 'refY'));
      if (refX !== null || refY !== null) {
        inside = Affine.compose(Affine.translation({ x: -(refX ?? 0), y: -(refY ?? 0) }), inside);
      }
    }
    const inner: Context = {
      ...ctx,
      m: Affine.compose(inside, Affine.compose(Affine.translation({ x, y }), Affine.compose(transform, ctx.m))),
      viewport,
    };
    for (const child of element.children) {
      this.enter(child, inner);
    }
  }

  /**
   * A `<use>`: what it refers to, drawn here — moved by the reference's `x`
   * and `y` after its own transform, and inheriting from the reference
   * rather than from where it is defined.
   */
  private use(element: XmlElement, ctx: Context, transform: Affine2): void {
    if (ctx.uses.includes(element) || ctx.uses.length >= MAX_USE_DEPTH) {
      ctx.tally.circular = true;
      return;
    }
    const href = (SvgReader.attribute(element, 'href') ?? SvgReader.attribute(element, 'href', XLINK_NAMESPACE))?.trim();
    if (href === undefined || href === '') {
      return;
    }
    if (!href.startsWith('#')) {
      // Another file: nothing is fetched.
      ctx.tally.external++;
      return;
    }
    const target = this.ids.get(href.slice(1));
    if (!target) {
      ctx.tally.missing.add(href);
      return;
    }
    // What holds the reference, or a reference being followed, cannot be what it draws.
    if ([element, ...ctx.uses].some((held) => SvgReader.holds(target, held))) {
      ctx.tally.circular = true;
      return;
    }
    const x = this.length(SvgReader.attribute(element, 'x'), 'x', ctx) ?? 0;
    const y = this.length(SvgReader.attribute(element, 'y'), 'y', ctx) ?? 0;
    const placed: Context = {
      ...ctx,
      m: Affine.compose(Affine.translation({ x, y }), Affine.compose(transform, ctx.m)),
      uses: [...ctx.uses, element],
    };
    if (target.local !== 'symbol' && target.local !== 'svg') {
      this.enter(target, placed);
      return;
    }
    if (target.namespace !== this.namespace || ++this.visits > MAX_VISITS) {
      return;
    }
    const declared = this.sheet.declared(target);
    if (target.local === 'svg' && declared.get('display')?.toLowerCase() === 'none') {
      return;
    }
    // A size on the reference replaces the one on what it draws; a negative one is not a size.
    const size = (name: 'width' | 'height'): number | null => {
      const value = this.length(SvgReader.attribute(element, name), name === 'width' ? 'x' : 'y', ctx);
      return value !== null && value >= 0 ? value : null;
    };
    const own = target.local === 'svg' ? this.transformOf(target, declared, placed) : Affine.IDENTITY;
    this.viewport(target, this.derive(placed, declared), own, size('width'), size('height'));
  }

  // ─── Shapes ─────────────────────────────────────────────────────────────

  /** A length in the context's user units; null when the text is not one. */
  private length(text: string | undefined, axis: 'x' | 'y' | 'other', ctx: Context): number | null {
    const length = SvgValues.length(text);
    if (!length) {
      return null;
    }
    if (length.unit === '%') {
      if (!ctx.viewport.known) {
        ctx.tally.percentWithoutPage = true;
      }
      const { width, height } = ctx.viewport;
      // Of the viewport's width, its height, or for a length along neither its diagonal over √2.
      const whole = axis === 'x' ? width : axis === 'y' ? height : Math.hypot(width, height) / Math.SQRT2;
      return (length.value / 100) * whole;
    }
    const factor = this.units[length.unit];
    return factor === undefined ? null : length.value * factor;
  }

  /** The outline of a shape element in its own coordinates; null when it draws nothing. */
  private shape(element: XmlElement, declared: ReadonlyMap<string, string>, ctx: Context): Subpath[] | null {
    const plain = (name: string, axis: 'x' | 'y' | 'other') => this.length(SvgReader.attribute(element, name), axis, ctx);
    // SVG 2 lets a style sheet set these; what is declared is the attribute when no rule says otherwise.
    const styled = (name: string, axis: 'x' | 'y' | 'other') => this.length(declared.get(name), axis, ctx);
    const closed = (segments: PathSegment[]): Subpath[] => [{ segments, closed: true }];

    switch (element.local) {
      case 'path': {
        let d = SvgReader.attribute(element, 'd');
        const fromStyle = declared.get('d');
        if (fromStyle !== undefined && fromStyle !== d?.trim()) {
          // The property is `path("…")`.
          const match = /^path\(\s*(["'])([\s\S]*)\1\s*\)$/.exec(fromStyle);
          d = match ? match[2] : fromStyle.toLowerCase() === 'none' ? '' : d;
        }
        if (d === undefined) {
          return null;
        }
        const path = SvgPathData.parse(d);
        if (path.error) {
          ctx.tally.pathErrors++;
        }
        return path.subpaths;
      }
      case 'rect': {
        const x = styled('x', 'x') ?? 0;
        const y = styled('y', 'y') ?? 0;
        const width = styled('width', 'x');
        const height = styled('height', 'y');
        if (width === null || height === null || !(width > 0) || !(height > 0)) {
          return null;
        }
        // A corner radius given for one axis only is the other's too; neither may pass half the side.
        let rx = styled('rx', 'x');
        let ry = styled('ry', 'y');
        rx = rx !== null && rx >= 0 ? rx : null;
        ry = ry !== null && ry >= 0 ? ry : null;
        rx = Math.min(rx ?? ry ?? 0, width / 2);
        ry = Math.min(ry ?? rx, height / 2);
        const [right, bottom] = [x + width, y + height];
        if (!(rx > 0) || !(ry > 0)) {
          const corners = [{ x, y }, { x: right, y }, { x: right, y: bottom }, { x, y: bottom }];
          return closed(corners.map((corner, i) => ({ kind: 'line', a: corner, b: corners[(i + 1) % 4] })));
        }
        const u = { x: rx, y: 0 };
        const v = { x: 0, y: ry };
        const quarter = Math.PI / 2;
        const corner = (cx: number, cy: number, from: number): PathSegment =>
          ({ kind: 'conic', center: { x: cx, y: cy }, u, v, t0: from, t1: from + quarter });
        const side = (ax: number, ay: number, bx: number, by: number): PathSegment =>
          ({ kind: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by } });
        // From the top edge's left end, the way the format has a rectangle drawn.
        return closed([
          side(x + rx, y, right - rx, y),
          corner(right - rx, y + ry, -quarter),
          side(right, y + ry, right, bottom - ry),
          corner(right - rx, bottom - ry, 0),
          side(right - rx, bottom, x + rx, bottom),
          corner(x + rx, bottom - ry, quarter),
          side(x, bottom - ry, x, y + ry),
          corner(x + rx, y + ry, 2 * quarter),
        ]);
      }
      case 'circle': {
        const r = styled('r', 'other');
        if (r === null || !(r > 0)) {
          return null;
        }
        const center = { x: styled('cx', 'x') ?? 0, y: styled('cy', 'y') ?? 0 };
        return closed([{ kind: 'conic', center, u: { x: r, y: 0 }, v: { x: 0, y: r }, t0: 0, t1: 2 * Math.PI }]);
      }
      case 'ellipse': {
        // One radius alone is both.
        let rx = styled('rx', 'x');
        let ry = styled('ry', 'y');
        rx = rx !== null && rx >= 0 ? rx : null;
        ry = ry !== null && ry >= 0 ? ry : null;
        rx = rx ?? ry;
        ry = ry ?? rx;
        if (rx === null || ry === null || !(rx > 0) || !(ry > 0)) {
          return null;
        }
        const center = { x: styled('cx', 'x') ?? 0, y: styled('cy', 'y') ?? 0 };
        return closed([{ kind: 'conic', center, u: { x: rx, y: 0 }, v: { x: 0, y: ry }, t0: 0, t1: 2 * Math.PI }]);
      }
      case 'line': {
        const a = { x: plain('x1', 'x') ?? 0, y: plain('y1', 'y') ?? 0 };
        const b = { x: plain('x2', 'x') ?? 0, y: plain('y2', 'y') ?? 0 };
        return [{ segments: [{ kind: 'line', a, b }], closed: false }];
      }
      case 'polyline':
      case 'polygon': {
        const numbers = SvgValues.numbers(SvgReader.attribute(element, 'points'));
        const segments: PathSegment[] = [];
        // A number left without its pair is dropped.
        const count = Math.floor(numbers.length / 2);
        const at = (i: number) => ({ x: numbers[2 * i], y: numbers[2 * i + 1] });
        for (let i = 0; i + 1 < count; i++) {
          segments.push({ kind: 'line', a: at(i), b: at(i + 1) });
        }
        const closes = element.local === 'polygon' && count > 2;
        if (closes) {
          segments.push({ kind: 'line', a: at(count - 1), b: at(0) });
        }
        return segments.length > 0 ? [{ segments, closed: closes }] : null;
      }
      default:
        return null;
    }
  }

  /** A shape's outline, taken into the drawing's coordinates and kept as curves. */
  private emit(subpaths: readonly Subpath[], ctx: Context, strokeOnly: boolean): void {
    const painted = SvgReader.isPainted(ctx, strokeOnly);
    let drawn = false;
    for (const subpath of subpaths) {
      const placed: PathSegment[] = [];
      for (const segment of subpath.segments) {
        const mapped = PathSegments.map(ctx.m, segment);
        if (PathSegments.isFinite(mapped) && PathSegments.reach(mapped) > 0) {
          placed.push(mapped);
        }
      }
      if (placed.length === 0) {
        continue;
      }
      const joined = PathSegments.joined({ segments: placed, closed: subpath.closed }, { arcs: this.arcs });
      if (painted) {
        ctx.tally.recognized += joined.recognized;
      } else {
        ctx.tally.recognizedUnpainted += joined.recognized;
      }
      for (const segment of joined.segments) {
        const size = segment.kind === 'conic'
          ? Math.max(Math.hypot(segment.u.x, segment.u.y), Math.hypot(segment.v.x, segment.v.y))
          : 1;
        const curve = PathSegments.curve(segment, size * RELATIVE_TOLERANCE);
        if (!curve) {
          continue;
        }
        if (ctx.out.length >= MAX_ENTITIES) {
          throw new Error(`The drawing has more than ${MAX_ENTITIES.toLocaleString('en-US')} curves once its references are followed: too many to import.`);
        }
        ctx.out.push({ layer: ctx.layer, hidden: ctx.hidden, curve, painted });
        drawn = true;
      }
    }
    if (drawn && !painted) {
      ctx.tally.unpainted++;
    }
    if (drawn && painted && ctx.clipped) {
      ctx.tally.clipped++;
    }
  }

  /** Whether a shape in this context shows: visible, with a fill (unless it is a line, which has none) or a stroke that has a width. */
  private static isPainted(ctx: Context, strokeOnly: boolean): boolean {
    if (ctx.transparent || ctx.visibility === 'hidden' || ctx.visibility === 'collapse') {
      return false;
    }
    // No paint, or a colour with no opacity at all: `#rrggbb00`, `rgba(…, 0)`.
    const paints = (paint: string) => paint !== 'none' && paint !== 'transparent'
      && !/^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/.test(paint)
      && !/^(?:rgba?|hsla?)\(.*[,/]\s*0(?:\.0*)?%?\s*\)$/.test(paint);
    const filled = !strokeOnly && paints(ctx.fill) && !SvgReader.isZero(ctx.fillOpacity);
    const stroked = paints(ctx.stroke) && !SvgReader.isZero(ctx.strokeWidth) && !SvgReader.isZero(ctx.strokeOpacity);
    return filled || stroked;
  }

  // ─── Result ─────────────────────────────────────────────────────────────

  private result(): ImportedDrawing {
    const tally = this.tally;
    const warnings = [...this.notes];
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

    // What the author saw is what comes in — unless nothing was painted at all, when the bare geometry is all there is.
    let kept = this.emitted.filter((emitted) => emitted.painted);
    let recognized = tally.recognized;
    if (this.unpainted) {
      kept = this.emitted;
      recognized += tally.recognizedUnpainted;
    } else if (kept.length === 0 && this.emitted.length > 0) {
      kept = this.emitted;
      recognized = tally.recognizedUnpainted;
      warnings.push('Nothing in the file is drawn with a fill or a stroke: its shapes were imported all the same.');
    } else if (tally.unpainted > 0) {
      warnings.push(`${count(tally.unpainted, 'shape has', 'shapes have')} neither a fill nor a stroke, or ${tally.unpainted === 1 ? 'is' : 'are'} made invisible: ${tally.unpainted === 1 ? 'it was' : 'they were'} left out.`);
    }

    const order: string[] = [];
    const counts = new Map<string, number>();
    const hidden = new Set<string>();
    const entities: ImportedEntity[] = kept.map((emitted) => {
      const layer = emitted.layer ?? NO_LAYER;
      if (!counts.has(layer)) {
        order.push(layer);
      }
      counts.set(layer, (counts.get(layer) ?? 0) + 1);
      if (emitted.hidden) {
        hidden.add(layer);
      }
      return { layer, curve: emitted.curve };
    });
    // Text its author could see, like the shapes — on the layers it is on.
    const texts: ImportedText[] = [];
    for (const emitted of this.texts) {
      if (!emitted.painted && !this.unpainted) {
        continue;
      }
      const layer = emitted.text.layer ?? NO_LAYER;
      if (!counts.has(layer)) {
        order.push(layer);
      }
      counts.set(layer, (counts.get(layer) ?? 0) + 1);
      if (emitted.hidden) {
        hidden.add(layer);
      }
      texts.push({ ...emitted.text, layer });
    }
    const layers: ImportedLayer[] = order.map((name) => ({ name, count: counts.get(name)!, hidden: hidden.has(name) }));

    if (tally.clipped > 0) {
      warnings.push(`${count(tally.clipped, 'shape is', 'shapes are')} clipped or masked in the file: ${tally.clipped === 1 ? 'it was' : 'they were'} imported whole.`);
    }
    if (recognized > 0) {
      warnings.push(`${count(recognized, 'bezier curve follows', 'bezier curves follow')} a circle and ${recognized === 1 ? 'was' : 'were'} read as ${recognized === 1 ? 'an arc' : 'arcs'}.`);
    }
    if (tally.pathErrors > 0) {
      warnings.push(`${count(tally.pathErrors, 'path has', 'paths have')} an error in ${tally.pathErrors === 1 ? 'its' : 'their'} data and ${tally.pathErrors === 1 ? 'was' : 'were'} read up to it.`);
    }
    if (tally.transformErrors > 0) {
      warnings.push(`${count(tally.transformErrors, 'transform', 'transforms')} could not be read (a syntax error, or one that leaves the plane) and ${tally.transformErrors === 1 ? 'was' : 'were'} ignored.`);
    }
    if (tally.missing.size > 0) {
      const names = [...tally.missing].slice(0, 8).map((name) => JSON.stringify(name)).join(', ');
      warnings.push(`The file refers to ${tally.missing.size === 1 ? 'an element' : 'elements'} it does not define (${names}${tally.missing.size > 8 ? ', …' : ''}); ${tally.missing.size === 1 ? 'it was' : 'they were'} left out.`);
    }
    if (tally.external > 0) {
      warnings.push(`${count(tally.external, 'reference points', 'references point')} to another file and ${tally.external === 1 ? 'was' : 'were'} left out.`);
    }
    if (tally.circular) {
      warnings.push('A reference leads back to itself, or references are nested too deep; it was left out.');
    }
    if (tally.percentWithoutPage) {
      warnings.push('Some sizes are given as percentages of a page the file does not give a size for; they were read as zero.');
    }
    return { unit: this.unit, layers, entities, points: [], constructionLines: this.guides, texts, skipped: tally.skipped, warnings };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private static newTally(): Tally {
    return {
      skipped: {},
      unpainted: 0,
      clipped: 0,
      transformErrors: 0,
      pathErrors: 0,
      recognized: 0,
      recognizedUnpainted: 0,
      missing: new Set(),
      external: 0,
      circular: false,
      percentWithoutPage: false,
    };
  }

  /** Whether `node` is `element` or inside it. */
  private static holds(element: XmlElement, node: XmlElement): boolean {
    for (let at: XmlElement | null = node; at; at = at.parent) {
      if (at === element) {
        return true;
      }
    }
    return false;
  }

  /** An attribute by its name without prefix, in `namespace` (none unless given). */
  private static attribute(element: XmlElement, local: string, namespace = ''): string | undefined {
    for (const attribute of element.attributes) {
      if (attribute.local === local && attribute.namespace === namespace) {
        return attribute.value;
      }
    }
    return undefined;
  }

  /** Whether a number, a length or a percentage is written and is zero. */
  private static isZero(text: string | undefined): boolean {
    return SvgValues.length(text)?.value === 0;
  }
}
