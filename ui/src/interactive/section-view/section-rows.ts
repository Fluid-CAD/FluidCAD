import type { SceneObjectRender, SourceLocation } from '../../types';
import type { SectionSpec, Vec3Tuple } from '../../scene/section-spec';
import { SectionPlaneMath } from '../../scene/section-spec';

/** One `section()` statement of the rendered scene, as its row serializes it. */
export type SectionRow = {
  /** Stable across renders and edits above the statement: its file and name (an ordinal tells same-named views apart). */
  key: string;
  name: string;
  origin: Vec3Tuple;
  normal: Vec3Tuple;
  offset: number;
  flip: boolean;
  sourceLocation: SourceLocation | null;
  /** The build error the row carries (a non-planar face), or null. */
  error: string | null;
};

/**
 * The row's identity across renders: its file and name, never its line —
 * a feature added above the statement moves the line, and the active view
 * would come back as "None". Same-named views in one file are told apart
 * by their order.
 */
function keyOf(row: SceneObjectRender, name: string, ordinal: number): string {
  const file = row.sourceLocation?.filePath ?? '';
  return `${file}:${name}#${ordinal}`;
}

/**
 * The scene's section views in statement order: every `section` row that
 * built (a row whose plane failed keeps its name and the error, for the
 * menu to say why it cannot be shown).
 */
export function collectSectionRows(result: SceneObjectRender[]): SectionRow[] {
  const rows: SectionRow[] = [];
  const seen = new Map<string, number>();
  for (const row of result) {
    if (row.type !== 'section') {
      continue;
    }
    const data = row.object as { name?: unknown; origin?: unknown; normal?: unknown; offset?: unknown; flip?: unknown } | undefined;
    const name = typeof data?.name === 'string' ? data.name : (row.name ?? 'Section');
    const ident = `${row.sourceLocation?.filePath ?? ''}:${name}`;
    const ordinal = seen.get(ident) ?? 0;
    seen.set(ident, ordinal + 1);
    const built = SectionPlaneMath.isVec3(data?.origin) && SectionPlaneMath.isVec3(data?.normal)
      && SectionPlaneMath.length(data!.normal as Vec3Tuple) > 0;
    rows.push({
      key: keyOf(row, name, ordinal),
      name,
      origin: built ? [...(data!.origin as Vec3Tuple)] : [0, 0, 0],
      normal: built ? [...(data!.normal as Vec3Tuple)] : [0, 0, 1],
      offset: typeof data?.offset === 'number' && Number.isFinite(data.offset) ? data.offset : 0,
      flip: data?.flip === true,
      sourceLocation: row.sourceLocation ?? null,
      error: row.hasError ? (row.errorMessage ?? 'This section view did not build.') : built ? null : 'This section view has no plane yet.',
    });
  }
  return rows;
}

/** The clip spec of a row, at its own offset or a live override (the arrow mid-drag). */
export function sectionSpecOf(row: SectionRow, offset: number = row.offset): SectionSpec {
  return { plane: { origin: row.origin, normal: row.normal }, offset, flip: row.flip };
}
