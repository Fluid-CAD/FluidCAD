import type { Vec2 } from "./drawing.js";

/** One line pair of a DXF: a group code and its value. */
export type DxfPair = { code: number; value: string };

/** One object of the file: its type (the group-0 value) and the pairs up to the next group 0. */
export type DxfRecord = { type: string; pairs: DxfPair[] };

/** Reading the values of a record by group code. */
export class DxfRecords {
  /** The first value with `code`; undefined when the record has none. */
  static text(record: DxfRecord, code: number): string | undefined {
    return record.pairs.find((pair) => pair.code === code)?.value;
  }

  /** Every value with `code`, in order. */
  static all(record: DxfRecord, code: number): string[] {
    return record.pairs.filter((pair) => pair.code === code).map((pair) => pair.value);
  }

  static num(record: DxfRecord, code: number, fallback: number): number {
    const value = DxfRecords.text(record, code);
    if (value === undefined || value === '') {
      return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  static int(record: DxfRecord, code: number, fallback: number): number {
    return Math.trunc(DxfRecords.num(record, code, fallback));
  }

  /** The points a record lists as repeated (`x`, `y`) groups, in order. */
  static points(record: DxfRecord, xCode: number, yCode: number): Vec2[] {
    const points: Vec2[] = [];
    for (const pair of record.pairs) {
      if (pair.code === xCode) {
        points.push({ x: Number(pair.value), y: 0 });
      } else if (pair.code === yCode && points.length > 0) {
        points[points.length - 1].y = Number(pair.value);
      }
    }
    return points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  }

  /** An entity's extrusion direction (210, 220, 230), one unit long: +Z unless the record says otherwise. */
  static extrusion(record: DxfRecord): { x: number; y: number; z: number } {
    const n = { x: DxfRecords.num(record, 210, 0), y: DxfRecords.num(record, 220, 0), z: DxfRecords.num(record, 230, 1) };
    const length = Math.hypot(n.x, n.y, n.z);
    return length > 0 ? { x: n.x / length, y: n.y / length, z: n.z / length } : { x: 0, y: 0, z: 1 };
  }
}
