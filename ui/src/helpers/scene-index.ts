import { SceneObjectRender } from '../types';

const NO_CHILDREN: readonly SceneObjectRender[] = Object.freeze([]);

const indexes = new WeakMap<readonly SceneObjectRender[], SceneIndex>();

/**
 * Parent / child / ancestor lookups over one render's flat scene list.
 *
 * A scene list is scanned by many readers per render — every dialog service,
 * the viewer, the mesh factory, the timeline — and each of them needs "the
 * row with this id" or "the rows under this one". Answering those with
 * `find` / `filter` over the list is O(n) per question and O(n²) per render,
 * which is what made large scenes (thousands of sketch entities) block the
 * page for seconds. The index answers them in O(1) and is built once per
 * list: {@link SceneIndex.of} keys on the array's identity, so every reader
 * of the same render shares one index and no helper signature changes.
 *
 * The contract that makes this safe: a scene list is never mutated after it
 * is received — derived lists are new arrays (and so get their own index).
 * Dev builds freeze the list on receipt; a list whose length changed since
 * indexing is re-indexed rather than served stale.
 *
 * Lookups keep the semantics of the scans they replace: `byId` is the FIRST
 * row carrying an id, children come back in scene order, and a dangling
 * `parentId` simply has no parent.
 */
export class SceneIndex {
  private readonly length: number;
  private readonly rowsById = new Map<string, SceneObjectRender>();
  private readonly childrenById = new Map<string, SceneObjectRender[]>();
  private readonly positions = new Map<SceneObjectRender, number>();
  private readonly enclosingMemo = new Map<string, Map<SceneObjectRender, SceneObjectRender | undefined>>();
  private readonly renderedGeometryMemo = new Map<SceneObjectRender, boolean>();
  private readonly rebuiltMemo = new Map<SceneObjectRender, boolean>();

  private constructor(sceneObjects: readonly SceneObjectRender[]) {
    this.length = sceneObjects.length;
    for (let i = 0; i < sceneObjects.length; i++) {
      const obj = sceneObjects[i];
      if (!this.positions.has(obj)) {
        this.positions.set(obj, i);
      }
      if (obj.id != null && !this.rowsById.has(obj.id)) {
        this.rowsById.set(obj.id, obj);
      }
      if (obj.parentId != null) {
        const siblings = this.childrenById.get(obj.parentId);
        if (siblings) {
          siblings.push(obj);
        } else {
          this.childrenById.set(obj.parentId, [obj]);
        }
      }
    }
  }

  /** The index of this scene list — built on first use, shared afterwards. */
  static of(sceneObjects: readonly SceneObjectRender[]): SceneIndex {
    const existing = indexes.get(sceneObjects);
    if (existing && existing.length === sceneObjects.length) {
      return existing;
    }
    const index = new SceneIndex(sceneObjects);
    indexes.set(sceneObjects, index);
    return index;
  }

  /** The first row carrying this id. */
  byId(id: string | null | undefined): SceneObjectRender | undefined {
    return id == null ? undefined : this.rowsById.get(id);
  }

  /** The rows whose `parentId` is this id, in scene order. */
  children(id: string | null | undefined): readonly SceneObjectRender[] {
    return (id == null ? undefined : this.childrenById.get(id)) ?? NO_CHILDREN;
  }

  /** Whether any row names this id as its parent. */
  hasChildren(id: string | null | undefined): boolean {
    return this.children(id).length > 0;
  }

  /** The row's position in the scene list, or -1 for a row that is not in it. */
  position(obj: SceneObjectRender): number {
    return this.positions.get(obj) ?? -1;
  }

  /** The row this one is nested under, if it is in the list. */
  parent(obj: SceneObjectRender): SceneObjectRender | undefined {
    return this.byId(obj.parentId);
  }

  /** A row with no parent, or one sitting directly in a part(). */
  isTopLevel(obj: SceneObjectRender): boolean {
    if (!obj.parentId) {
      return true;
    }
    return this.parent(obj)?.type === 'part';
  }

  /** The nearest strict ancestor of the given type (a row is never its own). */
  enclosing(obj: SceneObjectRender, type: string): SceneObjectRender | undefined {
    let memo = this.enclosingMemo.get(type);
    if (!memo) {
      memo = new Map();
      this.enclosingMemo.set(type, memo);
    }
    if (memo.has(obj)) {
      return memo.get(obj);
    }
    // Walk up until an ancestor of the type, an already-answered row, or the
    // root; everything passed on the way shares the answer.
    const path: SceneObjectRender[] = [obj];
    const onPath = new Set<SceneObjectRender>(path);
    let result: SceneObjectRender | undefined;
    let current = this.parent(obj);
    while (current && !onPath.has(current)) {
      if (current.type === type) {
        result = current;
        break;
      }
      if (memo.has(current)) {
        result = memo.get(current);
        break;
      }
      path.push(current);
      onPath.add(current);
      current = this.parent(current);
    }
    for (const row of path) {
      memo.set(row, result);
    }
    return result;
  }

  /** Every ancestor of the row, nearest first. */
  ancestors(obj: SceneObjectRender): SceneObjectRender[] {
    const out: SceneObjectRender[] = [];
    const seen = new Set<SceneObjectRender>([obj]);
    let current = this.parent(obj);
    while (current && !seen.has(current)) {
      out.push(current);
      seen.add(current);
      current = this.parent(current);
    }
    return out;
  }

  /**
   * The row, or anything nested under it, puts drawn geometry on screen — a
   * sketch's geometry renders on its entity rows, not on the sketch itself.
   */
  hasRenderedGeometry(obj: SceneObjectRender): boolean {
    const known = this.renderedGeometryMemo.get(obj);
    if (known !== undefined) {
      return known;
    }
    // Claim the row before descending so a malformed parent cycle terminates.
    this.renderedGeometryMemo.set(obj, false);
    let result = (obj.sceneShapes ?? []).some(s => !s.isMetaShape && !s.isGuide && (s.meshes?.length ?? 0) > 0);
    if (!result) {
      for (const child of this.children(obj.id)) {
        if (child !== obj && this.hasRenderedGeometry(child)) {
          result = true;
          break;
        }
      }
    }
    this.renderedGeometryMemo.set(obj, result);
    return result;
  }

  /**
   * The row with this id, or anything nested under it, was rebuilt by this
   * render (`fromCache` false) rather than carried over by the scene compare.
   */
  subtreeRebuilt(id: string | null | undefined): boolean {
    const root = this.byId(id);
    if (root) {
      return this.rowSubtreeRebuilt(root);
    }
    return this.children(id).some(child => this.rowSubtreeRebuilt(child));
  }

  private rowSubtreeRebuilt(obj: SceneObjectRender): boolean {
    const known = this.rebuiltMemo.get(obj);
    if (known !== undefined) {
      return known;
    }
    this.rebuiltMemo.set(obj, false);
    let result = !obj.fromCache;
    if (!result) {
      for (const child of this.children(obj.id)) {
        if (this.rowSubtreeRebuilt(child)) {
          result = true;
          break;
        }
      }
    }
    this.rebuiltMemo.set(obj, result);
    return result;
  }
}
