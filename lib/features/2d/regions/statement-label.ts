// Readable labels for the statements of a sketch, for messages and payloads.
//
// The kernel identifies a region boundary by statement objects, never by
// variable names (see region-ref.ts). When it has to SHOW one — a feature's
// error naming the regions a declaration could mean, the picker's overlay
// keys — a statement reads as its callee and its ordinal among the sketch's
// statements of that callee: `circle#2` is the sketch's second circle. The
// label is display only; nothing resolves through it.

import { SceneObject } from "../../../common/scene-object.js";
import type { RegionItem } from "./region-ref.js";

/** Kernel type → the callee the statement was written with. */
const CALLEE_BY_TYPE: Record<string, string> = {
  line: 'line',
  arc: 'arc',
  circle: 'circle',
  point: 'point',
  ellipse: 'ellipse',
  bezier: 'bezier',
  rect: 'rect',
  text: 'text',
  projection: 'project',
  intersect: 'intersect',
  offset: 'offset',
  fillet2d: 'fillet',
  'copy-linear': 'copy',
  'copy-circular': 'copy',
  mirror: 'mirror',
  rotate: 'rotate',
};

export function statementCallee(obj: SceneObject): string {
  const type = obj.getType();
  return CALLEE_BY_TYPE[type] ?? type.replace(/[^\w$]/g, '_');
}

/**
 * The statements of a sketch in statement order, each with its label and
 * its position — the order region items sort by canonically.
 */
export class StatementLabels {
  private readonly labels = new Map<SceneObject, string>();
  private readonly order = new Map<SceneObject, number>();

  constructor(statements: SceneObject[]) {
    const counts = new Map<string, number>();
    statements.forEach((statement, index) => {
      this.order.set(statement, index);
      const callee = statementCallee(statement);
      const ordinal = (counts.get(callee) ?? 0) + 1;
      counts.set(callee, ordinal);
      this.labels.set(statement, `${callee}#${ordinal}`);
    });
  }

  /** The statements this table knows, in statement order. */
  static ofSketchChildren(children: SceneObject[]): StatementLabels {
    return new StatementLabels(children.filter(child => !child.isLazy() && !child.isSelection()));
  }

  labelOf(statement: SceneObject): string {
    return this.labels.get(statement) ?? `${statementCallee(statement)}#?`;
  }

  orderOf(statement: SceneObject): number {
    return this.order.get(statement) ?? Number.MAX_SAFE_INTEGER;
  }

  /** `circle#2`, `rect#1.top`, `far(circle#2)`. */
  formatItem(item: RegionItem): string {
    const text = [this.labelOf(item.owner), ...item.path].join('.');
    return item.right ? `far(${text})` : text;
  }

  /** The items of a region as one readable key: `circle#1 far(circle#2)`. */
  formatItems(items: RegionItem[]): string {
    return items.map(item => this.formatItem(item)).join(' ');
  }
}
