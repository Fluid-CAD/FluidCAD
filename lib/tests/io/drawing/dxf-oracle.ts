// A reader for the tests only: just enough DXF to check what `DxfWriter`
// wrote, written from the format's definition rather than from the writer —
// group codes in, geometry out — so a slip in the writer (degrees for
// radians, a knot short, an arc the wrong way round) shows up as a curve
// that is not where the drawing put it.

export type DxfPair = { code: number; value: string };

/** One object of the file: its type (the group-0 value) and the pairs up to the next group 0. */
export type DxfObject = { type: string; pairs: DxfPair[] };

export type DxfSection = { name: string; objects: DxfObject[] };

export type DxfFile = { pairs: DxfPair[]; sections: DxfSection[] };

type P2 = { x: number; y: number };

export class DxfReader {
  /** Splits the text into group-code pairs and sections; throws on anything malformed. */
  static parse(text: string): DxfFile {
    const lines = text.split('\r\n');
    if (lines.pop() !== '') {
      throw new Error('DXF does not end with a line break');
    }
    if (lines.length % 2 !== 0) {
      throw new Error(`DXF has an odd number of lines (${lines.length}): a group code without a value`);
    }
    const pairs: DxfPair[] = [];
    for (let i = 0; i < lines.length; i += 2) {
      if (!/^\d+$/.test(lines[i])) {
        throw new Error(`Line ${i + 1}: group code expected, got ${JSON.stringify(lines[i])}`);
      }
      pairs.push({ code: Number(lines[i]), value: lines[i + 1] });
    }
    if (pairs[pairs.length - 1]?.code !== 0 || pairs[pairs.length - 1].value !== 'EOF') {
      throw new Error('DXF does not end with EOF');
    }

    const sections: DxfSection[] = [];
    let section: DxfSection | null = null;
    let object: DxfObject | null = null;
    for (let i = 0; i < pairs.length - 1; i++) {
      const pair = pairs[i];
      if (pair.code === 0 && pair.value === 'SECTION') {
        const name = pairs[++i];
        if (section || name.code !== 2) {
          throw new Error('Malformed SECTION');
        }
        section = { name: name.value, objects: [] };
        object = null;
        continue;
      }
      if (!section) {
        throw new Error(`Group ${pair.code} outside any section`);
      }
      if (pair.code === 0 && pair.value === 'ENDSEC') {
        sections.push(section);
        section = null;
        object = null;
        continue;
      }
      if (pair.code === 0) {
        object = { type: pair.value, pairs: [] };
        section.objects.push(object);
        continue;
      }
      if (!object) {
        // HEADER has no group-0 objects: its variables are (9, name) runs.
        object = { type: '', pairs: [] };
        section.objects.push(object);
      }
      object.pairs.push(pair);
    }
    if (section) {
      throw new Error(`Section ${section.name} is not closed`);
    }
    return { pairs, sections };
  }

  static section(file: DxfFile, name: string): DxfSection {
    const section = file.sections.find((s) => s.name === name);
    if (!section) {
      throw new Error(`No ${name} section`);
    }
    return section;
  }

  /** The value pairs of a header variable (`$INSUNITS` → its group 70). */
  static headerVariable(file: DxfFile, name: string): DxfPair[] {
    const pairs = DxfReader.section(file, 'HEADER').objects.flatMap((o) => o.pairs);
    const start = pairs.findIndex((p) => p.code === 9 && p.value === name);
    if (start < 0) {
      throw new Error(`No header variable ${name}`);
    }
    const values: DxfPair[] = [];
    for (let i = start + 1; i < pairs.length && pairs[i].code !== 9; i++) {
      values.push(pairs[i]);
    }
    return values;
  }

  static first(object: DxfObject, code: number): string | undefined {
    return object.pairs.find((p) => p.code === code)?.value;
  }

  static all(object: DxfObject, code: number): string[] {
    return object.pairs.filter((p) => p.code === code).map((p) => p.value);
  }

  static number(object: DxfObject, code: number): number {
    const value = DxfReader.first(object, code);
    if (value === undefined) {
      throw new Error(`${object.type} has no group ${code}`);
    }
    return Number(value);
  }

  /** The tables of the TABLES section: name → its header object and its entries. */
  static tables(file: DxfFile): Map<string, { header: DxfObject; entries: DxfObject[] }> {
    const tables = new Map<string, { header: DxfObject; entries: DxfObject[] }>();
    let current: { header: DxfObject; entries: DxfObject[] } | null = null;
    for (const object of DxfReader.section(file, 'TABLES').objects) {
      if (object.type === 'TABLE') {
        current = { header: object, entries: [] };
        tables.set(DxfReader.first(object, 2)!, current);
      } else if (object.type === 'ENDTAB') {
        current = null;
      } else if (current) {
        current.entries.push(object);
      } else {
        throw new Error(`${object.type} outside a table`);
      }
    }
    return tables;
  }

  /**
   * `count + 1` points along an entity, start to end, evenly spaced in its
   * own parameter — by the DXF definition of each entity type.
   */
  static sample(entity: DxfObject, count: number): P2[] {
    const n = (code: number) => DxfReader.number(entity, code);
    const points: P2[] = [];
    switch (entity.type) {
      case 'LINE':
        for (let i = 0; i <= count; i++) {
          const f = i / count;
          points.push({ x: n(10) + (n(11) - n(10)) * f, y: n(20) + (n(21) - n(20)) * f });
        }
        return points;
      case 'CIRCLE':
        for (let i = 0; i <= count; i++) {
          const a = (2 * Math.PI * i) / count;
          points.push({ x: n(10) + n(40) * Math.cos(a), y: n(20) + n(40) * Math.sin(a) });
        }
        return points;
      case 'ARC': {
        // Degrees, counter-clockwise from 50 to 51.
        const start = n(50);
        let sweep = (n(51) - start) % 360;
        if (sweep <= 0) {
          sweep += 360;
        }
        for (let i = 0; i <= count; i++) {
          const a = ((start + (sweep * i) / count) * Math.PI) / 180;
          points.push({ x: n(10) + n(40) * Math.cos(a), y: n(20) + n(40) * Math.sin(a) });
        }
        return points;
      }
      case 'ELLIPSE': {
        // Radians; 11/21 is the major axis end point relative to the centre,
        // the minor axis is the major one turned a quarter turn
        // counter-clockwise (extrusion +Z) and scaled by the ratio.
        const [mx, my, ratio] = [n(11), n(21), n(40)];
        const start = n(41);
        let end = n(42);
        if (end <= start) {
          end += 2 * Math.PI;
        }
        for (let i = 0; i <= count; i++) {
          const t = start + ((end - start) * i) / count;
          points.push({
            x: n(10) + Math.cos(t) * mx - Math.sin(t) * ratio * my,
            y: n(20) + Math.cos(t) * my + Math.sin(t) * ratio * mx,
          });
        }
        return points;
      }
      case 'SPLINE': {
        const degree = n(71);
        const knots = DxfReader.all(entity, 40).map(Number);
        const xs = DxfReader.all(entity, 10).map(Number);
        const ys = DxfReader.all(entity, 20).map(Number);
        const weights = DxfReader.all(entity, 41).map(Number);
        const t0 = knots[degree];
        const t1 = knots[xs.length];
        for (let i = 0; i <= count; i++) {
          // The last sample sits a hair inside the domain: the basis below is
          // defined on half-open spans.
          const t = i === count ? t1 - (t1 - t0) * 1e-12 : t0 + ((t1 - t0) * i) / count;
          let x = 0;
          let y = 0;
          let w = 0;
          for (let k = 0; k < xs.length; k++) {
            const b = DxfReader.basis(knots, k, degree, t) * (weights.length > 0 ? weights[k] : 1);
            x += b * xs[k];
            y += b * ys[k];
            w += b;
          }
          points.push({ x: x / w, y: y / w });
        }
        return points;
      }
      case 'LWPOLYLINE': {
        const xs = DxfReader.all(entity, 10).map(Number);
        const ys = DxfReader.all(entity, 20).map(Number);
        const vertices = xs.map((x, i) => ({ x, y: ys[i] }));
        if ((n(70) & 1) === 1) {
          vertices.push(vertices[0]);
        }
        const perSegment = Math.max(1, Math.ceil(count / Math.max(1, vertices.length - 1)));
        for (let s = 0; s + 1 < vertices.length; s++) {
          for (let i = s === 0 ? 0 : 1; i <= perSegment; i++) {
            const f = i / perSegment;
            points.push({
              x: vertices[s].x + (vertices[s + 1].x - vertices[s].x) * f,
              y: vertices[s].y + (vertices[s + 1].y - vertices[s].y) * f,
            });
          }
        }
        return points;
      }
    }
    throw new Error(`Cannot sample a ${entity.type}`);
  }

  /** The B-spline basis function N(k, degree) at `t`, by the Cox–de Boor recursion. */
  private static basis(knots: number[], k: number, degree: number, t: number): number {
    if (degree === 0) {
      return knots[k] <= t && t < knots[k + 1] ? 1 : 0;
    }
    let value = 0;
    const left = knots[k + degree] - knots[k];
    if (left > 0) {
      value += ((t - knots[k]) / left) * DxfReader.basis(knots, k, degree - 1, t);
    }
    const right = knots[k + degree + 1] - knots[k + 1];
    if (right > 0) {
      value += ((knots[k + degree + 1] - t) / right) * DxfReader.basis(knots, k + 1, degree - 1, t);
    }
    return value;
  }
}
