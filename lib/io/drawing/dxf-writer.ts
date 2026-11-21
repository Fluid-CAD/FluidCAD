import type { LengthUnit } from "../../units/units.js";
import { MM_PER_UNIT } from "../../units/units.js";
import type { Curve2D, Drawing2D, DrawingLayer } from "./drawing.js";
import { Curves, DRAWING_LAYERS } from "./drawing.js";
import { BSplineCurve2D } from "./bspline.js";

/** `$INSUNITS`: the unit one drawing unit stands for. */
const INSUNITS: Record<LengthUnit, number> = { in: 1, ft: 2, mm: 4, cm: 5, m: 6 };

/** `$MEASUREMENT`: 0 imperial, 1 metric — which linetype and hatch files a reader pairs the drawing with. */
const MEASUREMENT: Record<LengthUnit, number> = { in: 0, ft: 0, mm: 1, cm: 1, m: 1 };

const LAYER_NAMES: Record<DrawingLayer, string> = { visible: 'VISIBLE', tangent: 'TANGENT', hidden: 'HIDDEN' };

/** AutoCAD colour index per layer: 7 is black/white, 8 and 9 the two greys. */
const LAYER_COLORS: Record<DrawingLayer, number> = { visible: 7, tangent: 9, hidden: 8 };

const CONTINUOUS = 'Continuous';
const HIDDEN_LINETYPE = 'HIDDEN';

/** AutoCAD's ISO `HIDDEN` pattern, in millimetres: a dash and a gap. */
const HIDDEN_DASH_MM = 6.35;
const HIDDEN_GAP_MM = 3.175;

/** Decimals a real is written with; trailing zeros are trimmed. */
const REAL_DECIMALS = 9;

const RAD_TO_DEG = 180 / Math.PI;

/**
 * How far the cubic written for a spline of higher degree may be from it,
 * in millimetres — the distance under which the drawing takes two points
 * for one (`DRAWING_TOLERANCE_MM`), so the cubic is the same curve by the
 * drawing's own measure.
 */
const SPLINE_FIT_TOLERANCE_MM = 1e-5;

/**
 * A `Drawing2D` as an AutoCAD 2000 (`AC1015`) ASCII DXF.
 *
 * The version is the usual baseline: it has `ELLIPSE`, `SPLINE` and
 * `LWPOLYLINE`, and every current reader takes it. Unlike R12 it is not
 * forgiving: AutoCAD refuses a file whose tables, block records or object
 * dictionary are missing, even though lenient readers load an
 * entities-only file. So the whole skeleton is written, every time:
 *
 * - `HEADER` — version, extents, units, the next free handle;
 * - `CLASSES` — empty (no custom objects);
 * - `TABLES` — `VPORT`, `LTYPE`, `LAYER`, `STYLE`, `VIEW`, `UCS`, `APPID`,
 *   `DIMSTYLE`, `BLOCK_RECORD`, with the entries a reader requires;
 * - `BLOCKS` — model space and paper space;
 * - `ENTITIES`;
 * - `OBJECTS` — the root dictionary and `ACAD_GROUP`.
 *
 * Every object has a unique handle and names its owner. The output depends
 * on nothing but the drawing: no date, no random id — the same drawing is
 * the same bytes.
 */
export class DxfWriter {
  static write(drawing: Drawing2D): string {
    // A malformed spline is named as such, before its bad numbers surface
    // as an unexplained NaN somewhere in the header.
    for (const entity of drawing.entities) {
      if (entity.curve.kind === 'bspline') {
        const invalid = BSplineCurve2D.invalidReason(entity.curve);
        if (invalid) {
          throw new Error(`Cannot write B-spline to DXF: ${invalid}`);
        }
      }
    }
    drawing = DxfWriter.readable(drawing);
    const out = new DxfText();
    const handles = new HandleAllocator();
    const layers = DRAWING_LAYERS.filter((layer) => drawing.entities.some((e) => e.layer === layer));
    const hidden = layers.includes('hidden');

    // Handles are given out in file order, so the file reads top to bottom
    // with ascending handles and `$HANDSEED` is simply the next one.
    const h = {
      vportTable: handles.next(),
      vport: handles.next(),
      ltypeTable: handles.next(),
      ltypeByBlock: handles.next(),
      ltypeByLayer: handles.next(),
      ltypeContinuous: handles.next(),
      ltypeHidden: hidden ? handles.next() : null,
      layerTable: handles.next(),
      layer0: handles.next(),
      layers: layers.map(() => handles.next()),
      styleTable: handles.next(),
      style: handles.next(),
      viewTable: handles.next(),
      ucsTable: handles.next(),
      appidTable: handles.next(),
      appid: handles.next(),
      dimstyleTable: handles.next(),
      dimstyle: handles.next(),
      blockRecordTable: handles.next(),
      modelSpaceRecord: handles.next(),
      paperSpaceRecord: handles.next(),
      modelSpaceBlock: handles.next(),
      modelSpaceEndBlock: handles.next(),
      paperSpaceBlock: handles.next(),
      paperSpaceEndBlock: handles.next(),
      entities: drawing.entities.map(() => handles.next()),
      rootDictionary: handles.next(),
      groupDictionary: handles.next(),
    };

    DxfWriter.header(out, drawing, handles.peek());

    out.section('CLASSES');
    out.endSection();

    out.section('TABLES');
    DxfWriter.vportTable(out, drawing, h.vportTable, h.vport);
    DxfWriter.ltypeTable(out, drawing.unit, h);
    DxfWriter.layerTable(out, layers, h);
    DxfWriter.styleTable(out, h.styleTable, h.style);
    out.table('VIEW', h.viewTable, 0);
    out.endTable();
    out.table('UCS', h.ucsTable, 0);
    out.endTable();
    DxfWriter.appidTable(out, h.appidTable, h.appid);
    DxfWriter.dimstyleTable(out, h.dimstyleTable, h.dimstyle, h.style);
    DxfWriter.blockRecordTable(out, h.blockRecordTable, h.modelSpaceRecord, h.paperSpaceRecord);
    out.endSection();

    out.section('BLOCKS');
    DxfWriter.block(out, '*Model_Space', h.modelSpaceBlock, h.modelSpaceEndBlock, h.modelSpaceRecord, false);
    DxfWriter.block(out, '*Paper_Space', h.paperSpaceBlock, h.paperSpaceEndBlock, h.paperSpaceRecord, true);
    out.endSection();

    out.section('ENTITIES');
    drawing.entities.forEach((entity, index) => {
      DxfWriter.entity(out, entity.curve, LAYER_NAMES[entity.layer], h.entities[index], h.modelSpaceRecord);
    });
    out.endSection();

    out.section('OBJECTS');
    out.text(0, 'DICTIONARY');
    out.text(5, h.rootDictionary);
    out.text(330, '0');
    out.text(100, 'AcDbDictionary');
    out.int(281, 1);
    out.text(3, 'ACAD_GROUP');
    out.text(350, h.groupDictionary);
    out.text(0, 'DICTIONARY');
    out.text(5, h.groupDictionary);
    out.text(330, h.rootDictionary);
    out.text(100, 'AcDbDictionary');
    out.int(281, 1);
    out.endSection();

    out.text(0, 'EOF');
    return out.toString();
  }

  /** A real as DXF text: fixed notation, never an exponent, never `-0`. Exposed for the tests. */
  static real(value: number): string {
    return DxfText.real(value);
  }

  // ─── Sections ───────────────────────────────────────────────────────────

  private static header(out: DxfText, drawing: Drawing2D, handSeed: string): void {
    const min = drawing.bounds?.min ?? { x: 0, y: 0 };
    const max = drawing.bounds?.max ?? { x: 0, y: 0 };
    out.section('HEADER');
    out.text(9, '$ACADVER');
    out.text(1, 'AC1015');
    out.text(9, '$DWGCODEPAGE');
    out.text(3, 'ANSI_1252');
    out.text(9, '$INSBASE');
    out.point(10, 0, 0, 0);
    out.text(9, '$EXTMIN');
    out.point(10, min.x, min.y, 0);
    out.text(9, '$EXTMAX');
    out.point(10, max.x, max.y, 0);
    out.text(9, '$LTSCALE');
    out.real(40, 1);
    out.text(9, '$LUNITS');
    out.int(70, 2);
    out.text(9, '$MEASUREMENT');
    out.int(70, MEASUREMENT[drawing.unit]);
    out.text(9, '$INSUNITS');
    out.int(70, INSUNITS[drawing.unit]);
    out.text(9, '$HANDSEED');
    out.text(5, handSeed);
    out.endSection();
  }

  /** The active viewport, framed on the drawing so the file opens looking at it. */
  private static vportTable(out: DxfText, drawing: Drawing2D, table: string, record: string): void {
    const min = drawing.bounds?.min ?? { x: 0, y: 0 };
    const max = drawing.bounds?.max ?? { x: 1, y: 1 };
    const aspect = 1.5;
    const height = (Math.max(max.y - min.y, (max.x - min.x) / aspect) || 1) * 1.1;
    out.table('VPORT', table, 1);
    out.text(0, 'VPORT');
    out.text(5, record);
    out.text(330, table);
    out.text(100, 'AcDbSymbolTableRecord');
    out.text(100, 'AcDbViewportTableRecord');
    out.text(2, '*ACTIVE');
    out.int(70, 0);
    out.point2(10, 0, 0);
    out.point2(11, 1, 1);
    out.point2(12, (min.x + max.x) / 2, (min.y + max.y) / 2);
    out.point2(13, 0, 0);
    out.point2(14, 10, 10);
    out.point2(15, 10, 10);
    out.point(16, 0, 0, 1);
    out.point(17, 0, 0, 0);
    out.real(40, height);
    out.real(41, aspect);
    out.real(42, 50);
    out.real(43, 0);
    out.real(44, 0);
    out.real(50, 0);
    out.real(51, 0);
    out.int(71, 0);
    out.int(72, 100);
    out.int(73, 1);
    out.int(74, 3);
    out.int(75, 0);
    out.int(76, 0);
    out.int(77, 0);
    out.int(78, 0);
    out.endTable();
  }

  private static ltypeTable(
    out: DxfText,
    unit: LengthUnit,
    h: { ltypeTable: string; ltypeByBlock: string; ltypeByLayer: string; ltypeContinuous: string; ltypeHidden: string | null },
  ): void {
    const record = (handle: string, name: string, description: string, pattern: number[]) => {
      out.text(0, 'LTYPE');
      out.text(5, handle);
      out.text(330, h.ltypeTable);
      out.text(100, 'AcDbSymbolTableRecord');
      out.text(100, 'AcDbLinetypeTableRecord');
      out.text(2, name);
      out.int(70, 0);
      out.text(3, description);
      out.int(72, 65);
      out.int(73, pattern.length);
      out.real(40, pattern.reduce((sum, length) => sum + Math.abs(length), 0));
      for (const length of pattern) {
        out.real(49, length);
        out.int(74, 0);
      }
    };
    out.table('LTYPE', h.ltypeTable, h.ltypeHidden ? 4 : 3);
    record(h.ltypeByBlock, 'ByBlock', '', []);
    record(h.ltypeByLayer, 'ByLayer', '', []);
    record(h.ltypeContinuous, CONTINUOUS, 'Solid line', []);
    if (h.ltypeHidden) {
      // The pattern is a length: sized in the drawing's own unit, so a dash
      // is the same 6.35 mm on paper whatever the document counts in.
      const perUnit = 1 / MM_PER_UNIT[unit];
      record(h.ltypeHidden, HIDDEN_LINETYPE, 'Hidden __ __ __ __ __ __ __ __', [HIDDEN_DASH_MM * perUnit, -HIDDEN_GAP_MM * perUnit]);
    }
    out.endTable();
  }

  private static layerTable(out: DxfText, layers: DrawingLayer[], h: { layerTable: string; layer0: string; layers: string[] }): void {
    const record = (handle: string, name: string, color: number, linetype: string) => {
      out.text(0, 'LAYER');
      out.text(5, handle);
      out.text(330, h.layerTable);
      out.text(100, 'AcDbSymbolTableRecord');
      out.text(100, 'AcDbLayerTableRecord');
      out.text(2, name);
      out.int(70, 0);
      out.int(62, color);
      out.text(6, linetype);
      out.int(370, -3);
    };
    out.table('LAYER', h.layerTable, layers.length + 1);
    record(h.layer0, '0', 7, CONTINUOUS);
    layers.forEach((layer, index) => {
      record(h.layers[index], LAYER_NAMES[layer], LAYER_COLORS[layer], layer === 'hidden' ? HIDDEN_LINETYPE : CONTINUOUS);
    });
    out.endTable();
  }

  private static styleTable(out: DxfText, table: string, record: string): void {
    out.table('STYLE', table, 1);
    out.text(0, 'STYLE');
    out.text(5, record);
    out.text(330, table);
    out.text(100, 'AcDbSymbolTableRecord');
    out.text(100, 'AcDbTextStyleTableRecord');
    out.text(2, 'Standard');
    out.int(70, 0);
    out.real(40, 0);
    out.real(41, 1);
    out.real(50, 0);
    out.int(71, 0);
    out.real(42, 2.5);
    out.text(3, 'txt');
    out.text(4, '');
    out.endTable();
  }

  private static appidTable(out: DxfText, table: string, record: string): void {
    out.table('APPID', table, 1);
    out.text(0, 'APPID');
    out.text(5, record);
    out.text(330, table);
    out.text(100, 'AcDbSymbolTableRecord');
    out.text(100, 'AcDbRegAppTableRecord');
    out.text(2, 'ACAD');
    out.int(70, 0);
    out.endTable();
  }

  /** The one table whose entries carry their handle under 105, not 5. */
  private static dimstyleTable(out: DxfText, table: string, record: string, style: string): void {
    out.table('DIMSTYLE', table, 1);
    out.text(100, 'AcDbDimStyleTable');
    out.int(71, 1);
    out.text(340, record);
    out.text(0, 'DIMSTYLE');
    out.text(105, record);
    out.text(330, table);
    out.text(100, 'AcDbSymbolTableRecord');
    out.text(100, 'AcDbDimStyleTableRecord');
    out.text(2, 'Standard');
    out.int(70, 0);
    out.text(340, style);
    out.endTable();
  }

  private static blockRecordTable(out: DxfText, table: string, modelSpace: string, paperSpace: string): void {
    const record = (handle: string, name: string) => {
      out.text(0, 'BLOCK_RECORD');
      out.text(5, handle);
      out.text(330, table);
      out.text(100, 'AcDbSymbolTableRecord');
      out.text(100, 'AcDbBlockTableRecord');
      out.text(2, name);
    };
    out.table('BLOCK_RECORD', table, 2);
    record(modelSpace, '*Model_Space');
    record(paperSpace, '*Paper_Space');
    out.endTable();
  }

  private static block(out: DxfText, name: string, begin: string, end: string, record: string, paperSpace: boolean): void {
    out.text(0, 'BLOCK');
    out.text(5, begin);
    out.text(330, record);
    out.text(100, 'AcDbEntity');
    if (paperSpace) {
      out.int(67, 1);
    }
    out.text(8, '0');
    out.text(100, 'AcDbBlockBegin');
    out.text(2, name);
    out.int(70, 0);
    out.point(10, 0, 0, 0);
    out.text(3, name);
    out.text(1, '');
    out.text(0, 'ENDBLK');
    out.text(5, end);
    out.text(330, record);
    out.text(100, 'AcDbEntity');
    if (paperSpace) {
      out.int(67, 1);
    }
    out.text(8, '0');
    out.text(100, 'AcDbBlockEnd');
  }

  // ─── Entities ───────────────────────────────────────────────────────────

  /**
   * One curve as its native entity. Colour and linetype are left to the
   * layer. Every entity lies in the world XY plane with the default +Z
   * extrusion, which is what lets arcs be written without the arbitrary-axis
   * transform: the drawing model's counter-clockwise is DXF's.
   */
  private static entity(out: DxfText, curve: Curve2D, layer: string, handle: string, owner: string): void {
    const begin = (type: string, subclass: string) => {
      out.text(0, type);
      out.text(5, handle);
      out.text(330, owner);
      out.text(100, 'AcDbEntity');
      out.text(8, layer);
      out.text(100, subclass);
    };
    switch (curve.kind) {
      case 'line':
        begin('LINE', 'AcDbLine');
        out.point(10, curve.a.x, curve.a.y, 0);
        out.point(11, curve.b.x, curve.b.y, 0);
        return;
      case 'circle':
        begin('CIRCLE', 'AcDbCircle');
        out.point(10, curve.center.x, curve.center.y, 0);
        out.real(40, curve.radius);
        return;
      case 'arc':
        // Angles are degrees here — the one entity that is not in radians.
        begin('ARC', 'AcDbCircle');
        out.point(10, curve.center.x, curve.center.y, 0);
        out.real(40, curve.radius);
        out.text(100, 'AcDbArc');
        out.real(50, DxfWriter.degrees(curve.start));
        out.real(51, DxfWriter.degrees(curve.end));
        return;
      case 'ellipse':
        // The major axis is an end point relative to the centre; the
        // parameters are radians, counter-clockwise, `end` past `start`.
        begin('ELLIPSE', 'AcDbEllipse');
        out.point(10, curve.center.x, curve.center.y, 0);
        out.point(11, curve.major.x, curve.major.y, 0);
        out.point(210, 0, 0, 1);
        out.real(40, curve.ratio);
        out.real(41, curve.start);
        out.real(42, curve.end);
        return;
      case 'bspline': {
        begin('SPLINE', 'AcDbSpline');
        out.point(210, 0, 0, 1);
        // 8: planar. 4: rational. Never closed or periodic: the model's
        // splines are clamped, and a clamped spline that happens to end
        // where it starts is still written as it is.
        out.int(70, 8 + (curve.weights ? 4 : 0));
        out.int(71, curve.degree);
        out.int(72, curve.knots.length);
        out.int(73, curve.poles.length);
        out.int(74, 0);
        out.real(42, 1e-7);
        out.real(43, 1e-7);
        for (const knot of curve.knots) {
          out.real(40, knot);
        }
        curve.poles.forEach((pole, index) => {
          out.point(10, pole.x, pole.y, 0);
          if (curve.weights) {
            out.real(41, curve.weights[index]);
          }
        });
        return;
      }
      case 'polyline':
        begin('LWPOLYLINE', 'AcDbPolyline');
        out.int(90, curve.points.length);
        out.int(70, curve.closed ? 1 : 0);
        for (const point of curve.points) {
          out.point2(10, point.x, point.y);
        }
        return;
    }
  }

  /**
   * The drawing with every spline in a form readers draw: degree 3 at most.
   * DXF allows any degree and the kernel's intersection curves are of
   * degree 5 or 6, but LibreCAD (and the importers built on the same
   * reader) show nothing at all for a spline above a cubic — the curve
   * where a wall meets a pipe was simply missing from the drawing. Such a
   * spline is written as the cubic within {@link SPLINE_FIT_TOLERANCE_MM}
   * of it; lower degrees, rational ones included, are written as they are.
   */
  private static readable(drawing: Drawing2D): Drawing2D {
    if (!drawing.entities.some((e) => e.curve.kind === 'bspline' && e.curve.degree > 3)) {
      return drawing;
    }
    const tolerance = Curves.tolerance(drawing.unit, SPLINE_FIT_TOLERANCE_MM);
    return {
      ...drawing,
      entities: drawing.entities.map((entity) =>
        entity.curve.kind === 'bspline' && entity.curve.degree > 3
          ? { ...entity, curve: BSplineCurve2D.toCubic(entity.curve, tolerance) }
          : entity),
    };
  }

  /** Radians → degrees in [0, 360). */
  private static degrees(radians: number): number {
    const degrees = (radians * RAD_TO_DEG) % 360;
    return degrees < 0 ? degrees + 360 : degrees;
  }
}

/** Hands out handles: unique, ascending, upper-case hex, never zero (zero is "no owner"). */
class HandleAllocator {
  private last = 0;

  next(): string {
    this.last++;
    return this.last.toString(16).toUpperCase();
  }

  /** The handle the next `next()` would return — what `$HANDSEED` declares. */
  peek(): string {
    return (this.last + 1).toString(16).toUpperCase();
  }
}

/** The file as it is written: a group code on one line, its value on the next. */
class DxfText {
  private readonly lines: string[] = [];

  text(code: number, value: string): void {
    this.lines.push(String(code), value);
  }

  int(code: number, value: number): void {
    if (!Number.isInteger(value)) {
      throw new Error(`DXF group ${code} takes an integer, got ${value}`);
    }
    this.lines.push(String(code), String(value));
  }

  real(code: number, value: number): void {
    this.lines.push(String(code), DxfText.real(value));
  }

  /** A 3D point: `code`, `code + 10`, `code + 20`. */
  point(code: number, x: number, y: number, z: number): void {
    this.real(code, x);
    this.real(code + 10, y);
    this.real(code + 20, z);
  }

  /** A 2D point: `code`, `code + 10`. */
  point2(code: number, x: number, y: number): void {
    this.real(code, x);
    this.real(code + 10, y);
  }

  section(name: string): void {
    this.text(0, 'SECTION');
    this.text(2, name);
  }

  endSection(): void {
    this.text(0, 'ENDSEC');
  }

  /** A symbol table's opening: name, handle, no owner, and how many entries follow. */
  table(name: string, handle: string, count: number): void {
    this.text(0, 'TABLE');
    this.text(2, name);
    this.text(5, handle);
    this.text(330, '0');
    this.text(100, 'AcDbSymbolTable');
    this.int(70, count);
  }

  endTable(): void {
    this.text(0, 'ENDTAB');
  }

  toString(): string {
    return this.lines.join('\r\n') + '\r\n';
  }

  /**
   * Fixed notation with the trailing zeros trimmed down to one decimal.
   * Readers disagree on exponents and choke on `nan`, so neither is ever
   * written: a value that cannot be written this way is an error.
   */
  static real(value: number): string {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot write ${value} to DXF`);
    }
    if (Math.abs(value) >= 1e15) {
      throw new Error(`Cannot write ${value} to DXF: too large for fixed notation`);
    }
    let text = value.toFixed(REAL_DECIMALS).replace(/0+$/, '');
    if (text.endsWith('.')) {
      text += '0';
    }
    return text === '-0.0' ? '0.0' : text;
  }
}
