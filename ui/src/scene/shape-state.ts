import type { SceneObjectPart, SceneObjectRender } from '../types';

/**
 * The root of an unnamed call-site lineage key, parsed:
 * `extrude@/ws/a.fluid.js:2:0#1:1.2` → type `extrude`, file `/ws/a.fluid.js`,
 * line 2, column 0, `rest` = `#1:1.2` (occurrence, ordinal and branches —
 * everything that identifies the body under that root).
 */
export type LineageRoot = {
  type: string;
  filePath: string;
  line: number;
  column: number;
  rest: string;
};

/**
 * Hidden and transparency state of the shapes panel, keyed so it survives
 * a render that mints new shape ids (D7 of shape-naming-and-lineage). A
 * solid is keyed by its `lineageKey` (the lib's BodyLineage: the feature
 * that created the body, followed through every fillet, cut, split and
 * copy); everything else — a sketch wire, a datum, a mesh without a lineage
 * — is keyed `shape:<shapeId>` and so lives exactly one render, as before.
 *
 * Every reader keeps working on shape ids: {@link index} maps the current
 * render both ways, and {@link hiddenShapeIds} / {@link opacityByShapeId}
 * derive the per-render views the viewer applies to its meshes.
 *
 * Across renders ({@link carry}, D8) a key still present is kept; a key
 * that vanished is carried to its branches (a split or a copy turned
 * `…:1` into `…:1.1` / `…:1.2` — every present key under `<key>.` takes
 * the state); an unnamed root whose statement moved along its line (`const
 * b = extrude(…)` binding it) is carried to the key with the same type,
 * file, line and body suffix at the new column, the way the timeline eye's
 * `carryShownKeys` carries a shown row. Anything else is pruned.
 */
export class LineageShapeState {
  private static readonly CALL_SITE_KEY = /^([^@:]+)@(.+):(\d+):(\d+)((?:#\d+)?:\d+(?:\.\d+)*)$/;
  private static readonly SHAPE_PREFIX = 'shape:';

  private readonly hidden = new Set<string>();
  private readonly opacities = new Map<string, number>();
  private keyByShapeId = new Map<string, string>();
  private shapeIdsByKey = new Map<string, string[]>();

  /** The state key of a rendered shape: its lineage key, else its shape id. */
  static keyFor(part: Pick<SceneObjectPart, 'shapeId' | 'lineageKey'>): string | undefined {
    if (part.lineageKey) {
      return part.lineageKey;
    }
    if (part.shapeId) {
      return `${LineageShapeState.SHAPE_PREFIX}${part.shapeId}`;
    }
    return undefined;
  }

  /** The call-site root of an unnamed lineage key; null for a named (`name:`), id-keyed (`id:`) or `shape:` key. */
  static parseRoot(key: string): LineageRoot | null {
    const match = LineageShapeState.CALL_SITE_KEY.exec(key);
    if (!match) {
      return null;
    }
    return {
      type: match[1],
      filePath: match[2],
      line: Number(match[3]),
      column: Number(match[4]),
      rest: match[5],
    };
  }

  /**
   * The keys of `keys` as they stand in a render holding `present` (D8):
   * kept when present, else carried to their branches, else to the same
   * root at a new column on the same line, else dropped.
   */
  static carryKeys(keys: ReadonlySet<string>, present: ReadonlySet<string>): Map<string, string[]> {
    const carried = new Map<string, string[]>();
    for (const key of keys) {
      carried.set(key, LineageShapeState.targetsOf(key, present));
    }
    return carried;
  }

  private static targetsOf(key: string, present: ReadonlySet<string>): string[] {
    if (present.has(key)) {
      return [key];
    }
    const branches = LineageShapeState.branchesOf(key, present);
    if (branches.length > 0) {
      return branches;
    }
    return LineageShapeState.movedRootsOf(key, present);
  }

  private static branchesOf(key: string, present: ReadonlySet<string>): string[] {
    const prefix = `${key}.`;
    const branches: string[] = [];
    for (const candidate of present) {
      if (candidate.startsWith(prefix)) {
        branches.push(candidate);
      }
    }
    return branches;
  }

  private static movedRootsOf(key: string, present: ReadonlySet<string>): string[] {
    const root = LineageShapeState.parseRoot(key);
    if (!root) {
      return [];
    }
    const moved: string[] = [];
    for (const candidate of present) {
      const other = LineageShapeState.parseRoot(candidate);
      if (other && other.type === root.type && other.filePath === root.filePath
        && other.line === root.line && other.column !== root.column && other.rest === root.rest) {
        moved.push(candidate);
      }
    }
    return moved;
  }

  /** Index the render's shapes both ways: the drawn ones and the ones a shown row would draw; meta shapes stay out. */
  index(sceneObjects: readonly SceneObjectRender[]): void {
    const keyByShapeId = new Map<string, string>();
    const shapeIdsByKey = new Map<string, string[]>();
    for (const obj of sceneObjects) {
      for (const part of [...(obj.sceneShapes ?? []), ...(obj.hiddenShapes ?? [])]) {
        if (part.isMetaShape || !part.shapeId || keyByShapeId.has(part.shapeId)) {
          continue;
        }
        const key = LineageShapeState.keyFor(part)!;
        keyByShapeId.set(part.shapeId, key);
        const ids = shapeIdsByKey.get(key);
        if (ids) {
          ids.push(part.shapeId);
        } else {
          shapeIdsByKey.set(key, [part.shapeId]);
        }
      }
    }
    this.keyByShapeId = keyByShapeId;
    this.shapeIdsByKey = shapeIdsByKey;
  }

  /** Carry the state onto the indexed render (D8), then drop what nothing in it answers to. */
  carry(): void {
    const present = new Set(this.shapeIdsByKey.keys());
    const hiddenTargets = LineageShapeState.carryKeys(this.hidden, present);
    this.hidden.clear();
    for (const targets of hiddenTargets.values()) {
      for (const target of targets) {
        this.hidden.add(target);
      }
    }
    const opacityTargets = LineageShapeState.carryKeys(new Set(this.opacities.keys()), present);
    const carriedOpacities = new Map<string, number>();
    for (const [key, targets] of opacityTargets) {
      const opacity = this.opacities.get(key)!;
      for (const target of targets) {
        // A key still present keeps its own value over one carried onto it.
        if (!carriedOpacities.has(target) || present.has(key)) {
          carriedOpacities.set(target, opacity);
        }
      }
    }
    this.opacities.clear();
    for (const [key, opacity] of carriedOpacities) {
      this.opacities.set(key, opacity);
    }
    this.prune();
  }

  /** Drop every key the indexed render does not hold. */
  prune(): void {
    for (const key of this.hidden) {
      if (!this.shapeIdsByKey.has(key)) {
        this.hidden.delete(key);
      }
    }
    for (const key of this.opacities.keys()) {
      if (!this.shapeIdsByKey.has(key)) {
        this.opacities.delete(key);
      }
    }
  }

  /** {@link index} + {@link carry} for a render that just arrived. */
  adopt(sceneObjects: readonly SceneObjectRender[]): void {
    this.index(sceneObjects);
    this.carry();
  }

  /** The state key a shape id answers to in the indexed render (a shape the index lacks is keyed by its id). */
  keyOf(shapeId: string): string {
    return this.keyByShapeId.get(shapeId) ?? `${LineageShapeState.SHAPE_PREFIX}${shapeId}`;
  }

  /** Every shape id of the indexed render that shares `shapeId`'s key (itself when the index lacks it). */
  shapeIdsSharing(shapeId: string): string[] {
    return this.shapeIdsByKey.get(this.keyOf(shapeId)) ?? [shapeId];
  }

  setHidden(shapeId: string, hidden: boolean): void {
    if (hidden) {
      this.hidden.add(this.keyOf(shapeId));
    } else {
      this.hidden.delete(this.keyOf(shapeId));
    }
  }

  isHidden(shapeId: string): boolean {
    return this.hidden.has(this.keyOf(shapeId));
  }

  /** An opacity of 1 (or more) clears the entry. */
  setOpacity(shapeId: string, opacity: number): void {
    if (opacity >= 1) {
      this.opacities.delete(this.keyOf(shapeId));
    } else {
      this.opacities.set(this.keyOf(shapeId), opacity);
    }
  }

  opacityOf(shapeId: string): number {
    return this.opacities.get(this.keyOf(shapeId)) ?? 1;
  }

  /** Clear every opacity; the shape ids of the indexed render that were faded. */
  clearOpacities(): string[] {
    const ids: string[] = [];
    for (const key of this.opacities.keys()) {
      ids.push(...(this.shapeIdsByKey.get(key) ?? []));
    }
    this.opacities.clear();
    return ids;
  }

  hasOpacities(): boolean {
    return this.opacities.size > 0;
  }

  /** The hidden shape ids of the indexed render. */
  hiddenShapeIds(): Set<string> {
    const ids = new Set<string>();
    for (const key of this.hidden) {
      for (const id of this.shapeIdsByKey.get(key) ?? []) {
        ids.add(id);
      }
    }
    return ids;
  }

  /** The faded shape ids of the indexed render with their opacity. */
  opacityByShapeId(): Map<string, number> {
    const byId = new Map<string, number>();
    for (const [key, opacity] of this.opacities) {
      for (const id of this.shapeIdsByKey.get(key) ?? []) {
        byId.set(id, opacity);
      }
    }
    return byId;
  }

  /** The state keys held, for tests and diagnostics. */
  hiddenKeys(): ReadonlySet<string> {
    return this.hidden;
  }

  opacityKeys(): ReadonlyMap<string, number> {
    return this.opacities;
  }
}
