import type { Curve2D, Vec2 } from "./drawing.js";
import { Curves } from "./drawing.js";
import { Affine, type Affine2 } from "./affine.js";
import { BSplineCurve2D } from "./bspline.js";
import { Conic } from "./conic.js";
import type { ImportedConstructionLine, ImportedDrawing, ImportedEntity, ImportedLayer, ImportedPoint, ImportedUnit } from "./import.js";
import { interpolateBSpline2d } from "../../math/bspline-interpolation.js";
import { DxfRecords, type DxfPair, type DxfRecord } from "./dxf-record.js";
import { DxfText } from "./dxf-text.js";
import type { ImportedText } from "./imported-text.js";

type Block = { base: Vec2; records: DxfRecord[] };

type Vec3 = { x: number; y: number; z: number };

/** A polyline vertex: where it is, and the bulge of the segment that leaves it. */
type PolylineVertex = { x: number; y: number; bulge: number };

const TWO_PI = 2 * Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/** `$INSUNITS`: the length of one drawing unit, for the codes that are a length a model could be drawn in. */
const INSUNITS: Record<number, ImportedUnit> = {
  1: { name: 'in', mm: 25.4 },
  2: { name: 'ft', mm: 304.8 },
  3: { name: 'mi', mm: 1609344 },
  4: { name: 'mm', mm: 1 },
  5: { name: 'cm', mm: 10 },
  6: { name: 'm', mm: 1000 },
  7: { name: 'km', mm: 1e6 },
  8: { name: 'µin', mm: 2.54e-5 },
  9: { name: 'mil', mm: 0.0254 },
  10: { name: 'yd', mm: 914.4 },
  11: { name: 'Å', mm: 1e-7 },
  12: { name: 'nm', mm: 1e-6 },
  13: { name: 'µm', mm: 1e-3 },
  14: { name: 'dm', mm: 100 },
  15: { name: 'dam', mm: 1e4 },
  16: { name: 'hm', mm: 1e5 },
  21: { name: 'US survey ft', mm: 1200000 / 3937 },
};

/** `$DWGCODEPAGE`: the encoding a file older than AutoCAD 2007 writes its text in. */
const CODE_PAGES: Record<string, string> = {
  ANSI_874: 'windows-874',
  ANSI_932: 'shift_jis',
  ANSI_936: 'gbk',
  ANSI_949: 'euc-kr',
  ANSI_950: 'big5',
  ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254',
  ANSI_1255: 'windows-1255',
  ANSI_1256: 'windows-1256',
  ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258',
};

/** How deep block references may nest before the reader stops following them. */
const MAX_BLOCK_DEPTH = 16;

/** A file that expands to more curves than this is refused: no sketch could take it. */
const MAX_ENTITIES = 200_000;

/** Tolerances are this share of the curve's own size: the file's unit is not known while it is read. */
const RELATIVE_TOLERANCE = 1e-9;

/** Entity types that are bookkeeping, not something drawn and left out. */
const SILENT_TYPES = new Set(['SEQEND', 'VERTEX', 'ATTRIB', 'ATTDEF', 'VIEWPORT', 'ENDBLK']);

/**
 * An ASCII DXF as the curves it draws, in the drawing model the writers
 * share. Written for the files people bring to a sketch — a laser profile, a
 * supplier's outline, a logo, a legacy 2D part — from any version of the
 * format (R12 to current), and lenient where real files are loose.
 *
 * What is read: `LINE`, `CIRCLE`, `ARC`, `ELLIPSE`, `SPLINE` (control points
 * with their knots and weights, or fit points alone), `LWPOLYLINE` and the
 * old `POLYLINE` with bulges (each segment a line or an arc), and `INSERT`
 * with its block expanded in place — moved, turned, scaled per axis,
 * mirrored, arrayed, nested. A `POINT` is read as a point, and an `XLINE`
 * or a `RAY` as a construction line, each apart from the curves. Model
 * space only; an entity made invisible is left out. `TEXT`, `MTEXT` and
 * the attribute values of a block reference are read as texts (see
 * `DxfText`); an attribute's definition (`ATTDEF`) is a template, not
 * something drawn, and is not. Everything else — dimensions, hatches,
 * images — is counted in `skipped`.
 *
 * Coordinates are the file's own: nothing is recentred or scaled; `unit`
 * says what the file declares. A drawing is taken as its top view: an entity
 * drawn on a plane other than XY (extrusion direction off ±Z) is projected
 * onto XY, and said so in `warnings`. A plane flipped over (extrusion −Z,
 * common in files from mirrored geometry) is not a tilt: it is read exactly.
 */
export class DxfReader {
  static read(text: string): ImportedDrawing {
    const reader = new DxfReader();
    reader.load(DxfReader.pairs(text));
    return reader.result();
  }

  /** {@link read} for a file's bytes, decoded as {@link decode} decodes them. */
  static readBytes(bytes: Uint8Array): ImportedDrawing {
    return DxfReader.read(DxfReader.decode(bytes));
  }

  /**
   * A file's bytes as text. Current files are UTF-8; one written before
   * AutoCAD 2007 is in the code page its header names (`$DWGCODEPAGE`), which
   * matters for the layer names of drawings made in Chinese, Japanese,
   * Korean, Cyrillic… — the numbers are ASCII either way. Bytes that are not
   * valid UTF-8 are read in that code page, Western European when the file
   * names none.
   */
  static decode(bytes: Uint8Array): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // Not UTF-8: a code page.
    }
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 64 * 1024));
    const named = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([^\r\n]+)/i.exec(head)?.[1].trim().toUpperCase();
    try {
      return new TextDecoder(CODE_PAGES[named ?? ''] ?? 'windows-1252').decode(bytes);
    } catch {
      // A runtime without that code page: the numbers still read.
      return new TextDecoder('latin1').decode(bytes);
    }
  }

  private readonly blocks = new Map<string, Block>();
  /** Layer names in the order the file names them: its table first, then as entities use them. */
  private readonly layerOrder: string[] = [];
  private readonly hiddenLayers = new Set<string>();
  private readonly entities: ImportedEntity[] = [];
  private readonly points: ImportedPoint[] = [];
  private readonly constructionLines: ImportedConstructionLine[] = [];
  private readonly texts: ImportedText[] = [];
  /** Reads text in the file's styles; set once the tables are read. */
  private text = new DxfText([]);
  private readonly skipped: Record<string, number> = {};
  private unitCode = 0;
  private projected = 0;
  private unreadableSplines = 0;
  private uniformKnotSplines = 0;
  private readonly missingBlocks = new Set<string>();
  private nestedTooDeep = false;

  private constructor() {}

  // ─── File structure ─────────────────────────────────────────────────────

  /** The text as (group code, value) pairs; throws on what is not an ASCII DXF. */
  private static pairs(text: string): DxfPair[] {
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    if (text.startsWith('AutoCAD Binary DXF')) {
      throw new Error('This is a binary DXF. Save the drawing as an ASCII (text) DXF and import that.');
    }
    if (/^AC1\d{3}/.test(text)) {
      throw new Error('This is a DWG file, not a DXF. Save the drawing as DXF and import that.');
    }
    const lines = text.split(/\r\n|\r|\n/);
    const pairs: DxfPair[] = [];
    for (let i = 0; i < lines.length; i += 2) {
      const code = lines[i].trim();
      if (!/^-?\d+$/.test(code)) {
        // Blank lines after the last pair are how many files end.
        if (lines.slice(i).every((line) => line.trim() === '')) {
          break;
        }
        const found = code.length > 24 ? `${code.slice(0, 24)}…` : code;
        throw new Error(`This is not a DXF file: line ${i + 1} should be a group code, and is ${JSON.stringify(found)}.`);
      }
      // What a text says (groups 1 and 3) keeps its spaces: a long text is cut into pieces anywhere, also after a space.
      const value = lines[i + 1] ?? '';
      pairs.push({ code: Number(code), value: code === '1' || code === '3' ? value : value.trim() });
    }
    if (!pairs.some((pair) => pair.code === 0 && pair.value === 'SECTION')) {
      throw new Error('This is not a DXF file: it has no sections.');
    }
    return pairs;
  }

  private load(pairs: DxfPair[]): void {
    const sections = new Map<string, DxfPair[]>();
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i].code !== 0 || pairs[i].value !== 'SECTION' || pairs[i + 1]?.code !== 2) {
        continue;
      }
      let end = i + 2;
      while (end < pairs.length && !(pairs[end].code === 0 && pairs[end].value === 'ENDSEC')) {
        end++;
      }
      sections.set(pairs[i + 1].value.toUpperCase(), pairs.slice(i + 2, end));
      i = end;
    }
    // Blocks before entities, whatever order the file has them in.
    this.header(sections.get('HEADER') ?? []);
    this.tables(DxfReader.records(sections.get('TABLES') ?? []));
    this.readBlocks(DxfReader.records(sections.get('BLOCKS') ?? []));
    this.emit(DxfReader.records(sections.get('ENTITIES') ?? []), Affine.IDENTITY, null, []);
  }

  private static records(pairs: DxfPair[]): DxfRecord[] {
    const records: DxfRecord[] = [];
    let current: DxfRecord | null = null;
    for (const pair of pairs) {
      if (pair.code === 0) {
        current = { type: pair.value.toUpperCase(), pairs: [] };
        records.push(current);
      } else if (current) {
        current.pairs.push(pair);
      }
    }
    return records;
  }

  private header(pairs: DxfPair[]): void {
    const at = pairs.findIndex((pair) => pair.code === 9 && pair.value.toUpperCase() === '$INSUNITS');
    if (at >= 0 && pairs[at + 1]?.code === 70) {
      const code = Number(pairs[at + 1].value);
      this.unitCode = Number.isFinite(code) ? code : 0;
    }
  }

  private tables(records: DxfRecord[]): void {
    this.text = new DxfText(records.filter((record) => record.type === 'STYLE'));
    for (const record of records) {
      if (record.type !== 'LAYER') {
        continue;
      }
      const name = DxfRecords.text(record, 2);
      if (name === undefined) {
        continue;
      }
      this.seeLayer(name);
      // Frozen (flag 1), or off: a layer that is off has its colour negated.
      if ((DxfRecords.int(record, 70, 0) & 1) !== 0 || DxfRecords.int(record, 62, 7) < 0) {
        this.hiddenLayers.add(name);
      }
    }
  }

  private readBlocks(records: DxfRecord[]): void {
    for (let i = 0; i < records.length; i++) {
      if (records[i].type !== 'BLOCK') {
        continue;
      }
      const head = records[i];
      let end = i + 1;
      while (end < records.length && records[end].type !== 'ENDBLK' && records[end].type !== 'BLOCK') {
        end++;
      }
      const name = DxfRecords.text(head, 2) ?? DxfRecords.text(head, 3)?.trim();
      if (name !== undefined) {
        this.blocks.set(name.toUpperCase(), {
          base: { x: DxfRecords.num(head, 10, 0), y: DxfRecords.num(head, 20, 0) },
          records: records.slice(i + 1, end),
        });
      }
      i = end - 1;
    }
  }

  // ─── Entities ───────────────────────────────────────────────────────────

  /**
   * The curves of `records`, each taken through `m` — the identity for the
   * file's own entities, the placement of a block reference for a block's.
   * `insertLayer` is the layer of the reference a block is drawn through:
   * what a block's layer-0 entities are on.
   */
  private emit(records: DxfRecord[], m: Affine2, insertLayer: string | null, stack: string[]): void {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      // A polyline's vertices and a reference's attributes follow it, up to SEQEND.
      let children: DxfRecord[] = [];
      if (record.type === 'POLYLINE' || (record.type === 'INSERT' && DxfRecords.int(record, 66, 0) === 1)) {
        let end = i + 1;
        while (end < records.length && (records[end].type === 'VERTEX' || records[end].type === 'ATTRIB')) {
          end++;
        }
        children = records.slice(i + 1, end);
        i = records[end]?.type === 'SEQEND' ? end : end - 1;
      }
      // Paper space (67) and entities made invisible (60) are not the drawing.
      if (DxfRecords.int(record, 67, 0) === 1 || DxfRecords.int(record, 60, 0) === 1) {
        continue;
      }
      const own = DxfRecords.text(record, 8) ?? '0';
      const layer = insertLayer !== null && own === '0' ? insertLayer : own;

      switch (record.type) {
        case 'LINE':
          this.add(layer, {
            kind: 'line',
            a: { x: DxfRecords.num(record, 10, 0), y: DxfRecords.num(record, 20, 0) },
            b: { x: DxfRecords.num(record, 11, 0), y: DxfRecords.num(record, 21, 0) },
          }, m);
          break;
        case 'CIRCLE': {
          const radius = DxfRecords.num(record, 40, 0);
          if (radius > 0) {
            this.add(layer, {
              kind: 'circle',
              center: { x: DxfRecords.num(record, 10, 0), y: DxfRecords.num(record, 20, 0) },
              radius,
            }, Affine.compose(this.ocs(record, DxfRecords.num(record, 30, 0)), m));
          }
          break;
        }
        case 'ARC': {
          const radius = DxfRecords.num(record, 40, 0);
          if (radius > 0) {
            // Degrees, counter-clockwise from 50 to 51; equal angles are a full turn.
            const start = Curves.normalizeAngle(DxfRecords.num(record, 50, 0) * DEG_TO_RAD);
            const sweep = DxfReader.sweep(start, DxfRecords.num(record, 51, 0) * DEG_TO_RAD);
            this.add(layer, {
              kind: 'arc',
              center: { x: DxfRecords.num(record, 10, 0), y: DxfRecords.num(record, 20, 0) },
              radius,
              start,
              end: start + sweep,
            }, Affine.compose(this.ocs(record, DxfRecords.num(record, 30, 0)), m));
          }
          break;
        }
        case 'ELLIPSE':
          this.add(layer, this.ellipse(record), m);
          break;
        case 'LWPOLYLINE': {
          const vertices: PolylineVertex[] = [];
          for (const pair of record.pairs) {
            const last = vertices[vertices.length - 1];
            if (pair.code === 10) {
              vertices.push({ x: Number(pair.value), y: 0, bulge: 0 });
            } else if (pair.code === 20 && last) {
              last.y = Number(pair.value);
            } else if (pair.code === 42 && last) {
              last.bulge = Number(pair.value);
            }
          }
          const placed = Affine.compose(this.ocs(record, DxfRecords.num(record, 38, 0)), m);
          for (const curve of DxfReader.polyline(vertices, (DxfRecords.int(record, 70, 0) & 1) !== 0)) {
            this.add(layer, curve, placed);
          }
          break;
        }
        case 'POLYLINE':
          this.oldPolyline(record, children, layer, m);
          break;
        case 'SPLINE':
          this.add(layer, this.spline(record), m);
          break;
        case 'INSERT':
          this.insert(record, layer, m, stack);
          // The reference's attribute values: text of its own, already where it shows.
          for (const child of children) {
            if (child.type === 'ATTRIB' && (DxfRecords.int(child, 70, 0) & 1) === 0 && DxfRecords.int(child, 60, 0) !== 1) {
              const childLayer = DxfRecords.text(child, 8) ?? '0';
              this.addText(this.text.text(child, insertLayer !== null && childLayer === '0' ? insertLayer : childLayer, m));
            }
          }
          break;
        case 'TEXT':
          this.addText(this.text.text(record, layer, m));
          break;
        case 'MTEXT':
          this.addText(this.text.mtext(record, layer, m));
          break;
        case 'POINT':
          this.addPoint(layer, { x: DxfRecords.num(record, 10, 0), y: DxfRecords.num(record, 20, 0) }, m);
          break;
        case 'XLINE':
        case 'RAY':
          this.addConstructionLine(
            layer,
            { x: DxfRecords.num(record, 10, 0), y: DxfRecords.num(record, 20, 0) },
            { x: DxfRecords.num(record, 11, 0), y: DxfRecords.num(record, 21, 0) },
            record.type === 'RAY',
            m,
          );
          break;
        default:
          if (!SILENT_TYPES.has(record.type)) {
            this.skipped[record.type] = (this.skipped[record.type] ?? 0) + 1;
          }
      }
    }
  }

  /** One curve of the file, taken through `m` and kept when something is left of it. */
  private add(layer: string, curve: Curve2D | null, m: Affine2): void {
    if (!curve) {
      return;
    }
    const scale = Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
    const placed = Affine.curve(m, curve, DxfReader.sizeOf(curve) * scale * RELATIVE_TOLERANCE);
    if (!placed || DxfReader.hasNaN(placed)) {
      return;
    }
    this.makeRoom();
    this.seeLayer(layer);
    this.entities.push({ layer, curve: placed });
  }

  /** Throws when the file has grown past what an import can take. */
  private makeRoom(): void {
    if (this.entities.length + this.points.length + this.constructionLines.length + this.texts.length >= MAX_ENTITIES) {
      throw new Error(`The drawing has more than ${MAX_ENTITIES.toLocaleString('en-US')} curves and points once its blocks are expanded: too many to import.`);
    }
  }

  /** One point of the file — world coordinates, seen from above like everything else — taken through `m`. */
  private addPoint(layer: string, at: Vec2, m: Affine2): void {
    const placed = Affine.point(m, at);
    if (!Number.isFinite(placed.x) || !Number.isFinite(placed.y)) {
      return;
    }
    this.makeRoom();
    this.seeLayer(layer);
    this.points.push({ layer, at: placed });
  }

  /** One text of the file, kept unless it draws nothing or lies nowhere. */
  private addText(text: ImportedText | null): void {
    if (!text || !Number.isFinite(text.at.x) || !Number.isFinite(text.at.y)) {
      return;
    }
    this.makeRoom();
    this.seeLayer(text.layer!);
    this.texts.push(text);
  }

  /**
   * An `XLINE` (endless both ways) or a `RAY` (endless one way): a point
   * and a direction, both world coordinates, taken through `m`. One that
   * runs straight at the viewer is a point seen from above, and left out.
   */
  private addConstructionLine(layer: string, at: Vec2, direction: Vec2, ray: boolean, m: Affine2): void {
    const placed = Affine.point(m, at);
    const along = Affine.vector(m, direction);
    const length = Math.hypot(along.x, along.y);
    if (!Number.isFinite(placed.x) || !Number.isFinite(placed.y) || !Number.isFinite(length) || !(length > 0)) {
      return;
    }
    this.makeRoom();
    this.seeLayer(layer);
    this.constructionLines.push({ layer, at: placed, direction: { x: along.x / length, y: along.y / length }, ray });
  }

  /**
   * An `ELLIPSE` on the drawing plane. Its centre and major axis are world
   * coordinates; the minor axis is the extrusion direction crossed with the
   * major one, so a flipped extrusion runs the parameter the other way — the
   * conic door sorts that out, and a tilt too.
   */
  private ellipse(record: DxfRecord): Curve2D | null {
    const major: Vec3 = { x: DxfRecords.num(record, 11, 0), y: DxfRecords.num(record, 21, 0), z: DxfRecords.num(record, 31, 0) };
    const ratio = DxfRecords.num(record, 40, 1);
    const length = Math.hypot(major.x, major.y, major.z);
    if (!(length > 0) || !(ratio > 0)) {
      return null;
    }
    const n = DxfRecords.extrusion(record);
    if (Math.abs(n.z) < 1 - 1e-9 || Math.abs(major.z) > length * 1e-9) {
      this.projected++;
    }
    const start = DxfRecords.num(record, 41, 0);
    const sweep = DxfReader.sweep(start, DxfRecords.num(record, 42, TWO_PI));
    return Conic.fromConjugateDiameters(
      { x: DxfRecords.num(record, 10, 0), y: DxfRecords.num(record, 20, 0) },
      { x: major.x, y: major.y },
      { x: (n.y * major.z - n.z * major.y) * ratio, y: (n.z * major.x - n.x * major.z) * ratio },
      start, start + sweep, length * RELATIVE_TOLERANCE,
    );
  }

  /** The old `POLYLINE` with its `VERTEX` entities: 2D with bulges, or a 3D polyline seen from above. Meshes are left out. */
  private oldPolyline(record: DxfRecord, children: DxfRecord[], layer: string, m: Affine2): void {
    const flags = DxfRecords.int(record, 70, 0);
    if ((flags & (16 | 64)) !== 0) {
      this.skipped['POLYLINE (mesh)'] = (this.skipped['POLYLINE (mesh)'] ?? 0) + 1;
      return;
    }
    const is3d = (flags & 8) !== 0;
    const splineFit = (flags & 4) !== 0;
    const vertices: PolylineVertex[] = [];
    for (const child of children) {
      if (child.type !== 'VERTEX') {
        continue;
      }
      // A spline-fit polyline keeps the frame it was fitted to as extra vertices (flag 16).
      if (splineFit && (DxfRecords.int(child, 70, 0) & 16) !== 0) {
        continue;
      }
      vertices.push({
        x: DxfRecords.num(child, 10, 0),
        y: DxfRecords.num(child, 20, 0),
        bulge: is3d ? 0 : DxfRecords.num(child, 42, 0),
      });
    }
    // A 3D polyline's vertices are world points; a 2D one's are in its own plane.
    const placed = is3d ? m : Affine.compose(this.ocs(record, DxfRecords.num(record, 30, 0)), m);
    for (const curve of DxfReader.polyline(vertices, (flags & 1) !== 0)) {
      this.add(layer, curve, placed);
    }
  }

  /**
   * A polyline as its segments: a line, or for a bulge the arc it stands
   * for. The bulge is the tangent of a quarter of the arc's angle, positive
   * when the arc turns counter-clockwise from its vertex to the next.
   */
  private static polyline(vertices: PolylineVertex[], closed: boolean): Curve2D[] {
    const curves: Curve2D[] = [];
    const count = closed ? vertices.length : vertices.length - 1;
    for (let i = 0; i < count; i++) {
      const from = vertices[i];
      const to = vertices[(i + 1) % vertices.length];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const chord = Math.hypot(dx, dy);
      if (!(chord > 0)) {
        continue;
      }
      const bulge = from.bulge;
      if (!Number.isFinite(bulge) || Math.abs(bulge) < 1e-12) {
        curves.push({ kind: 'line', a: { x: from.x, y: from.y }, b: { x: to.x, y: to.y } });
        continue;
      }
      // The centre sits on the chord's bisector, to its left for a
      // counter-clockwise arc under a half turn.
      const offset = (chord * (1 - bulge * bulge)) / (4 * bulge);
      const center = {
        x: (from.x + to.x) / 2 - (dy / chord) * offset,
        y: (from.y + to.y) / 2 + (dx / chord) * offset,
      };
      const radius = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
      const sweep = 4 * Math.atan(Math.abs(bulge));
      // Stored counter-clockwise: a clockwise arc is read from its other end.
      const first = bulge > 0 ? from : to;
      const start = Curves.normalizeAngle(Math.atan2(first.y - center.y, first.x - center.x));
      curves.push({ kind: 'arc', center, radius, start, end: start + sweep });
    }
    return curves;
  }

  /**
   * A `SPLINE`: its control points with their knots and weights when it has
   * them, else the curve through its fit points. Coordinates are world
   * coordinates. Null, and counted, when the file gives neither.
   */
  private spline(record: DxfRecord): Curve2D | null {
    const degree = DxfRecords.int(record, 71, 3);
    const poles = DxfRecords.points(record, 10, 20);
    if (degree >= 1 && poles.length >= degree + 1) {
      let knots = DxfRecords.all(record, 40).map(Number);
      if (knots.length !== poles.length + degree + 1) {
        knots = DxfReader.uniformClampedKnots(poles.length, degree);
        this.uniformKnotSplines++;
      }
      const weights = DxfRecords.all(record, 41).map(Number);
      const rational = weights.length === poles.length && weights.some((w) => Math.abs(w - 1) > 1e-12);
      const curve: Curve2D = { kind: 'bspline', degree, knots, poles, ...(rational ? { weights } : {}) };
      const [t0, t1] = BSplineCurve2D.domain(curve);
      if (BSplineCurve2D.invalidReason(curve) === null && t1 > t0) {
        return BSplineCurve2D.clamped(curve);
      }
    }
    const fit = DxfRecords.points(record, 11, 21);
    if (fit.length >= 2) {
      try {
        const data = interpolateBSpline2d(fit);
        return {
          kind: 'bspline',
          degree: data.degree,
          knots: BSplineCurve2D.flattenKnots(data.knots, data.multiplicities),
          poles: data.poles,
        };
      } catch {
        // Fewer than two distinct points: nothing to draw.
      }
    }
    this.unreadableSplines++;
    return null;
  }

  private static uniformClampedKnots(poleCount: number, degree: number): number[] {
    const knots: number[] = [];
    const spans = poleCount - degree;
    for (let i = 0; i <= degree; i++) {
      knots.push(0);
    }
    for (let i = 1; i < spans; i++) {
      knots.push(i);
    }
    for (let i = 0; i <= degree; i++) {
      knots.push(spans);
    }
    return knots;
  }

  /**
   * A block reference: the block's entities, moved to the insertion point,
   * turned, scaled per axis (a negative scale mirrors) and repeated in rows
   * and columns when the reference is an array.
   */
  private insert(record: DxfRecord, layer: string, m: Affine2, stack: string[]): void {
    const name = DxfRecords.text(record, 2) ?? '';
    const key = name.toUpperCase();
    const block = this.blocks.get(key);
    if (!block) {
      this.missingBlocks.add(name);
      return;
    }
    if (stack.includes(key) || stack.length >= MAX_BLOCK_DEPTH) {
      this.nestedTooDeep = true;
      return;
    }
    const sx = DxfRecords.num(record, 41, 1);
    const sy = DxfRecords.num(record, 42, 1);
    const angle = DxfRecords.num(record, 50, 0) * DEG_TO_RAD;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const columns = Math.max(1, DxfRecords.int(record, 70, 1));
    const rows = Math.max(1, DxfRecords.int(record, 71, 1));
    const columnStep = DxfRecords.num(record, 44, 0);
    const rowStep = DxfRecords.num(record, 45, 0);
    const at = { x: DxfRecords.num(record, 10, 0), y: DxfRecords.num(record, 20, 0) };
    const outer = Affine.compose(this.ocs(record, DxfRecords.num(record, 30, 0)), m);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        // p ↦ at + R · (S · (p − base) + (column step, row step))
        const ox = column * columnStep - sx * block.base.x;
        const oy = row * rowStep - sy * block.base.y;
        const local: Affine2 = {
          a: cos * sx,
          b: sin * sx,
          c: -sin * sy,
          d: cos * sy,
          e: at.x + cos * ox - sin * oy,
          f: at.y + sin * ox + cos * oy,
        };
        this.emit(block.records, Affine.compose(local, outer), layer, [...stack, key]);
      }
    }
  }

  // ─── Planes ─────────────────────────────────────────────────────────────

  /**
   * From an entity's own plane to the drawing: circles, arcs, polylines and
   * block references give their points in a frame built from their extrusion
   * direction by the format's "arbitrary axis" rule. For the usual +Z it is
   * the identity; for −Z a mirror; for anything else the frame is tilted
   * and its XY part is the projection seen from above (`elevation` is the
   * entity's height in that frame, which a tilt carries sideways).
   */
  private ocs(record: DxfRecord, elevation: number): Affine2 {
    const n = DxfRecords.extrusion(record);
    if (n.x === 0 && n.y === 0 && n.z > 0) {
      return Affine.IDENTITY;
    }
    if (Math.abs(n.z) < 1 - 1e-9) {
      this.projected++;
    }
    // X axis: the world Y axis crossed with the normal when the normal is
    // close to Z, else the world Z axis crossed with it. Y axis: normal × X.
    const nearZ = Math.abs(n.x) < 1 / 64 && Math.abs(n.y) < 1 / 64;
    let ax: Vec3 = nearZ ? { x: n.z, y: 0, z: -n.x } : { x: -n.y, y: n.x, z: 0 };
    const length = Math.hypot(ax.x, ax.y, ax.z);
    ax = { x: ax.x / length, y: ax.y / length, z: ax.z / length };
    const ay = { x: n.y * ax.z - n.z * ax.y, y: n.z * ax.x - n.x * ax.z };
    return { a: ax.x, b: ax.y, c: ay.x, d: ay.y, e: n.x * elevation, f: n.y * elevation };
  }

  // ─── Result ─────────────────────────────────────────────────────────────

  private seeLayer(name: string): void {
    if (!this.layerOrder.includes(name)) {
      this.layerOrder.push(name);
    }
  }

  private result(): ImportedDrawing {
    const counts = new Map<string, number>();
    for (const drawn of [...this.entities, ...this.points, ...this.constructionLines, ...this.texts]) {
      // Everything a DXF draws is on a layer.
      counts.set(drawn.layer!, (counts.get(drawn.layer!) ?? 0) + 1);
    }
    const layers: ImportedLayer[] = this.layerOrder
      .filter((name) => counts.has(name))
      .map((name) => ({ name, count: counts.get(name)!, hidden: this.hiddenLayers.has(name) }));

    const warnings: string[] = [];
    const unit = INSUNITS[this.unitCode] ?? null;
    if (this.unitCode !== 0 && !unit) {
      warnings.push(`The file declares a unit this import has no length for ($INSUNITS ${this.unitCode}); its numbers are taken as they are.`);
    }
    if (this.projected > 0) {
      warnings.push(
        `${DxfReader.count(this.projected, 'entity is', 'entities are')} not drawn on the XY plane: `
        + `${this.projected === 1 ? 'it was' : 'they were'} projected onto it, as seen from above.`,
      );
    }
    if (this.unreadableSplines > 0) {
      warnings.push(`${DxfReader.count(this.unreadableSplines, 'spline has', 'splines have')} neither control points nor fit points and ${this.unreadableSplines === 1 ? 'was' : 'were'} left out.`);
    }
    if (this.uniformKnotSplines > 0) {
      warnings.push(`${DxfReader.count(this.uniformKnotSplines, 'spline comes', 'splines come')} without usable knots: evenly spaced ones were assumed.`);
    }
    if (this.missingBlocks.size > 0) {
      const names = [...this.missingBlocks].map((name) => JSON.stringify(name)).join(', ');
      warnings.push(`The file refers to ${this.missingBlocks.size === 1 ? 'a block' : 'blocks'} it does not define (${names}); ${this.missingBlocks.size === 1 ? 'it was' : 'they were'} left out.`);
    }
    if (this.nestedTooDeep) {
      warnings.push('A block refers to itself, or blocks are nested too deep; the reference was left out.');
    }
    return {
      unit,
      layers,
      entities: this.entities,
      points: this.points,
      constructionLines: this.constructionLines,
      texts: this.texts,
      skipped: this.skipped,
      warnings,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /** The counter-clockwise sweep from `start` to `end`, in (0, 2π]: equal angles are a full turn. */
  private static sweep(start: number, end: number): number {
    const sweep = ((end - start) % TWO_PI + TWO_PI) % TWO_PI;
    return sweep > 1e-12 ? sweep : TWO_PI; // unit: angular
  }

  /** How big a curve is, for a tolerance relative to it. */
  private static sizeOf(curve: Curve2D): number {
    switch (curve.kind) {
      case 'line':
        return Math.hypot(curve.b.x - curve.a.x, curve.b.y - curve.a.y);
      case 'circle':
      case 'arc':
        return curve.radius;
      case 'ellipse':
        return Math.hypot(curve.major.x, curve.major.y);
      case 'bspline':
      case 'polyline':
        return 1;
    }
  }

  private static hasNaN(curve: Curve2D): boolean {
    const bad = (p: Vec2) => !Number.isFinite(p.x) || !Number.isFinite(p.y);
    switch (curve.kind) {
      case 'line':
        return bad(curve.a) || bad(curve.b);
      case 'circle':
        return bad(curve.center) || !Number.isFinite(curve.radius);
      case 'arc':
        return bad(curve.center) || !Number.isFinite(curve.radius) || !Number.isFinite(curve.start) || !Number.isFinite(curve.end);
      case 'ellipse':
        return bad(curve.center) || bad(curve.major) || !Number.isFinite(curve.ratio);
      case 'bspline':
        return curve.poles.some(bad);
      case 'polyline':
        return curve.points.some(bad);
    }
  }

  private static count(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
  }
}
