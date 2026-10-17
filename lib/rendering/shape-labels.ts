/**
 * The row label of every drawn shape — `<Type> <n>` — as the Shapes panel
 * lists it and the scene summary reports it, computed from the rendered
 * payload alone so the ui and the server number the same way.
 *
 * n is the shape's 1-based ordinal per part and per shape type: holders in
 * timeline order, shapes in their holder's order. A shape no part holds
 * counts under "Model". Meta shapes (a sketch's plane quad, a feature's
 * guide) have no row and no label.
 *
 * The number is a label, never an identity: it renumbers when a shape of the
 * same type lands above it. State is keyed on `lineageKey` (BodyLineage).
 *
 * This module imports nothing so the ui can compile it in directly.
 */

/** The shape fields the labels read — satisfied by the lib's and the ui's payload types. */
export type LabelledShape = {
  shapeId?: string;
  shapeType?: string;
  isMetaShape?: boolean;
};

/** The row fields the labels read — satisfied by the lib's and the ui's payload types. */
export type LabelledRow = {
  id?: string;
  name?: string;
  type?: string;
  parentId?: string | null;
  sceneShapes?: readonly LabelledShape[];
};

export type ShapeLabel<R extends LabelledRow = LabelledRow> = {
  shapeId: string;
  shapeType: string;
  /** `<Type> <n>` — "Solid 2", "Face 1". */
  label: string;
  /** The enclosing part's name; null for a shape no part holds ("Model"). */
  part: string | null;
  /** The enclosing part row; null for a part-less shape. */
  partRow: R | null;
  /** The row that holds the shape. */
  holder: R;
};

export class ShapeLabels {
  /** The group title of the shapes no part holds. */
  static readonly MODEL_LABEL = 'Model';

  /**
   * One entry per drawn shape of `rendered` (timeline order of the holder,
   * then the holder's order), keyed by shape id. A shape without an id has
   * no handle and is left out, as are meta shapes.
   */
  static labelsFor<R extends LabelledRow>(rendered: readonly R[]): Map<string, ShapeLabel<R>> {
    const byId = ShapeLabels.rowsById(rendered);
    const ordinals = new Map<R | null, Map<string, number>>();
    const labels = new Map<string, ShapeLabel<R>>();

    for (const holder of rendered) {
      const shapes = (holder.sceneShapes ?? []).filter((shape) => !shape.isMetaShape);
      if (shapes.length === 0) {
        continue;
      }
      const partRow = ShapeLabels.enclosingPart(holder, byId);
      let counts = ordinals.get(partRow);
      if (!counts) {
        counts = new Map<string, number>();
        ordinals.set(partRow, counts);
      }
      for (const shape of shapes) {
        const shapeType = shape.shapeType || 'unknown';
        const ordinal = (counts.get(shapeType) ?? 0) + 1;
        counts.set(shapeType, ordinal);
        if (!shape.shapeId) {
          continue;
        }
        labels.set(shape.shapeId, {
          shapeId: shape.shapeId,
          shapeType,
          label: `${ShapeLabels.typeLabel(shapeType)} ${ordinal}`,
          part: partRow ? (partRow.name ?? null) : null,
          partRow,
          holder,
        });
      }
    }
    return labels;
  }

  /** The capitalised shape type a label starts with. */
  static typeLabel(shapeType: string): string {
    return shapeType.charAt(0).toUpperCase() + shapeType.slice(1);
  }

  /**
   * The part row a holder files under: itself for a part row, else the
   * nearest part up its `parentId` chain; null when no part holds it.
   */
  static enclosingPart<R extends LabelledRow>(row: R, byId: ReadonlyMap<string, R>): R | null {
    let current: R | undefined = row;
    const seen = new Set<R>();
    while (current && !seen.has(current)) {
      if (current.type === 'part') {
        return current;
      }
      seen.add(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return null;
  }

  private static rowsById<R extends LabelledRow>(rendered: readonly R[]): Map<string, R> {
    const byId = new Map<string, R>();
    for (const row of rendered) {
      if (row.id && !byId.has(row.id)) {
        byId.set(row.id, row);
      }
    }
    return byId;
  }
}
