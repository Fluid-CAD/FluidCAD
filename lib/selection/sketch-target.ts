export type SolvedEmissionRole = 'start' | 'end' | 'center' | 'mid';

/** A producer edit required before an outside consumer can name a sketch point. */
export type SketchExportRequest = {
  sketch: { line: number; column: number; filePath: string };
  target: SolvedEmissionTarget;
};

export type SolvedEmissionTarget = {
  /** 1-indexed line of an existing entity statement… */
  line?: number;
  /**
   * Loop-instance targeting: present when the statement at `line` executed
   * more than once in the last render (a user `for` loop) — the 0-based
   * execution index of the picked instance. Composes only with `line`;
   * absent defaults to instance 0 when the statement sits in a loop.
   */
  occurrence?: number;
  /** …or an index into this emission's `geometry` array… */
  newIndex?: number;
  /** …or an implicit sketch datum, rendered as its accessor call
   * (origin()/xAxis()/yAxis()) — datums have no source statement. */
  datum?: 'origin' | 'x-axis' | 'y-axis';
  /** Point accessor rendered as `.role()`; absent = the entity itself. */
  role?: SolvedEmissionRole;
  /** For `line` targets: the entity command the statement must call — a
   * mismatch means the source changed under the picks and refuses the edit.
   * References (P6) name their producer callee: 'project' | 'intersect';
   * copy-instance targets name theirs: 'copy'; anchor-point targets (P8)
   * name theirs: 'text' | 'bezier' — rendered as the anchor accessor
   * (`t.anchor()`, `bz.point(i)`). */
  featureType?: 'line' | 'arc' | 'circle' | 'point' | 'ellipse' | 'project' | 'intersect' | 'copy' | 'mirror'
    | 'text' | 'bezier' | 'offset';
  /**
   * Offset edge targets: the index of the picked edge on the 2D offset()
   * statement at `line` — renders `o.edge(i)` before the point role
   * (`o.edge(2).start()`, `.end()`, `.center()` for an arc). Requires
   * `featureType: 'offset'`; composes with `line`, `occurrence` and `role`
   * only — never `refIndex`/`instanceIndex`/`pointIndex`/`source`. Offset
   * edges have no solver identity, so these targets serve sketch exports
   * (points named from outside the sketch), never constraints.
   */
  edgeIndex?: number;
  /**
   * Mirror-image targets: the mirrored statement whose image on the 2D
   * mirror() statement at `line` is picked — itself a line-addressed
   * target (an entity statement, a copy instance, another mirror's
   * instance — never a datum/newIndex, never with a role), rendered
   * recursively: `m1.instance(l1)`, `m1.instance(cp1.instance(2))`.
   * Requires `featureType: 'mirror'`; composes with `line`, `role` and
   * `occurrence` — never `refIndex`/`instanceIndex`/`pointIndex`.
   */
  source?: SolvedEmissionTarget;
  /**
   * Fixed reference targets (P6): the `.ref(i)` edge index of the
   * project()/intersect() statement at `line`; null renders the terse
   * single-entity form (`p1`, `p1.center()`). Presence marks the target as
   * a reference.
   */
  refIndex?: number | null;
  /**
   * Copy-instance targets: the slot index of the picked duplicate on the 2D
   * copy() statement at `line` — renders `cp.instance(k)` (the original
   * occupies its own slot; duplicates fill the others; `skip` leaves holes).
   * Composes with `line`, `role` and `occurrence` (a copy() inside a user
   * loop rides the collector rail: `copies[1].instance(2)`); NEVER with
   * `datum`/`newIndex`, and v1 never with `refIndex`.
   */
  instanceIndex?: number;
  /**
   * Anchor-point targets (P8): a bezier literal control point's 0-based
   * index on the bezier statement at `line` — renders `bz.point(i)`.
   * Requires `featureType: 'bezier'`; the `text` anchor target carries no
   * index (its accessor is fixed: `.anchor()`).
   * Composes with `line` and `occurrence` only — never `datum`/`newIndex`/
   * `role`/`refIndex`/`instanceIndex`.
   */
  pointIndex?: number;
};

/** Compose the existing sketch target rail around a caller-supplied binding. */
export function renderSolvedTarget(
  target: SolvedEmissionTarget,
  bind: (target: SolvedEmissionTarget) => string,
): string {
  let name = bind(target);
  if (typeof target.refIndex === 'number') {
    name += `.ref(${target.refIndex})`;
  }
  if (target.instanceIndex !== undefined) {
    name += `.instance(${target.instanceIndex})`;
  }
  if (target.featureType === 'bezier') {
    name += `.point(${target.pointIndex})`;
  } else if (target.featureType === 'text') {
    name += '.anchor()';
  } else if (target.featureType === 'mirror') {
    name += `.instance(${renderSolvedTarget(target.source!, bind)})`;
  } else if (target.featureType === 'offset') {
    name += `.edge(${target.edgeIndex})`;
  }
  return target.role ? `${name}.${target.role}()` : name;
}

export const SOLVED_ENTITY_NAME_HINTS: Record<string, string> = {
  line: 'l', arc: 'a', circle: 'c', point: 'p', project: 'prj', intersect: 'sec',
  copy: 'cp', mirror: 'm', ellipse: 'el', text: 't', bezier: 'bz', offset: 'o',
};
