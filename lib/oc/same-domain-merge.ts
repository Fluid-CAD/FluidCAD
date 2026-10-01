import type {
  BRepBuilderAPI_Copy,
  BRepTools_History,
  ShapeUpgrade_UnifySameDomain,
  TopAbs_ShapeEnum,
  TopoDS_Shape,
} from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { ShapeHasher } from "./shape-hash.js";
import { SurfaceFrame, SurfaceFrames, SurfaceTolerance } from "./surface-frames.js";

export type SameDomainMergeOptions = {
  unifyEdges: boolean;
  unifyFaces: boolean;
  /** The unifier's `ConcatBSplines` flag; off unless given. */
  concatBSplines?: boolean;
  /** Forwarded to `SetSafeInputMode` when given; the kernel default otherwise. */
  safeInput?: boolean;
  /** Forwarded to `AllowInternalEdges` when given; the kernel default otherwise. */
  allowInternalEdges?: boolean;
  /** Forwarded to `SetLinearTolerance` when given; the kernel default otherwise. */
  linearTolerance?: number;
  /** Forwarded to `SetAngularTolerance` when given; the kernel default otherwise. */
  angularTolerance?: number;
  /**
   * Skip the BRepCheck of a merge that had no periodic group to give up on,
   * and report it valid — what the boolean builders' own `SimplifyResult`
   * does for every merge.
   */
  trustSafeMerge?: boolean;
};

export type SameDomainMergeResult = {
  /** The merged shape. When `valid` is false it is the first pass's output, kept for a repair. */
  shape: TopoDS_Shape;
  /** Whether `shape` passes BRepCheck. */
  valid: boolean;
  /** Lineage from the input's faces/edges/vertices to `shape`'s. */
  history: BRepTools_History;
  /** Frees the unifiers and the history. `shape` stays valid. */
  dispose(): void;
};

type Pass = { unify: ShapeUpgrade_UnifySameDomain; shape: TopoDS_Shape; valid: boolean };

/**
 * An adopted step: the lineage into its result and the unifier that produced
 * it (none for the plain copy a retry starts from).
 */
type Adopted = { unify: ShapeUpgrade_UnifySameDomain | null; history: BRepTools_History };

/** Adjacent faces of one shell that still lie on one surface after a merge pass. */
type StuckGroup = {
  shell: TopoDS_Shape;
  /** Every face of the shell, in the order the kernel visits them. */
  faces: TopoDS_Shape[];
  frames: (SurfaceFrame | null)[];
  /** Indices into `faces`, ascending. The first is the face the kernel merged the group onto. */
  members: number[];
};

/**
 * `ShapeUpgrade_UnifySameDomain` with a retry for the groups it gives up on.
 *
 * The kernel merges a group of same-surface faces onto the surface of the
 * group's FIRST face in shell order. On a periodic surface that choice can
 * make the merge impossible: when the reference is a full cylinder whose seam
 * line runs through a partial face of the group (a boss ring around an ear
 * whose rounded end it shares, the ring standing proud on both sides), the
 * merged face needs a seam where the group only has an ordinary edge, the
 * wire cannot be closed, and `IntUnifyFaces` does a bare `return` — which
 * also drops every group it had not reached yet in that shell. The body
 * keeps the seam line across the ear, the ring circles and each hole in
 * stacked pieces, although the same faces merge fine with another member of
 * the group as the reference.
 *
 * So after a pass, adjacent same-surface faces that are still separate are
 * taken as a stuck group, and the body holding them is merged again with its
 * shell listing another member first — one whose surface is parametrized
 * differently from the references already tried. A group no reference merges
 * is moved to the end of its shell, so the kernel reaches every other group
 * before it gives up on that one. A retry is adopted only when it is
 * BRepCheck-valid and left fewer faces.
 *
 * A pass that gives up leaves the pcurves it was building on the edges it
 * touched, and those can invalidate the shape it ran on. So every retry runs
 * on a topological copy of the one body (geometry shared): a rejected retry
 * costs nothing, an adopted one hands back new TShapes for that body, and
 * the other bodies of a compound keep theirs. The history therefore chains
 * input → copy → merged for every adopted retry; callers must follow the
 * sub-shapes of a merged body through it rather than by identity.
 *
 * A body with no periodic group to merge costs one look at its curved faces
 * and nothing else — it gets the first pass untouched, so its face order and
 * the index picks made on it stay put. One that has such a group also costs
 * the pristine copy and a second look after the pass.
 */
export class SameDomainMerge {

  /** Retries beyond the first pass, over all stuck groups of a shape. */
  private static readonly MAX_RETRIES = 8;

  /** References tried for one stuck group, beyond the kernel's own pick. */
  private static readonly MAX_REFERENCES = 4;

  static run(shape: TopoDS_Shape, options: SameDomainMergeOptions): SameDomainMergeResult {
    const oc = getOC();

    // Only a group on a periodic surface can make the kernel give up, and a
    // pass that gives up can leave its input damaged. When the input holds
    // such a group, keep a pristine copy to retry from.
    const risky = options.unifyFaces && SameDomainMerge.stuckGroups(shape, options, true).length > 0;
    const backup = risky ? new oc.BRepBuilderAPI_Copy(shape, false, false) : null;

    let first: Pass;
    try {
      first = SameDomainMerge.pass(shape, options, risky || !options.trustSafeMerge);
    } catch (error) {
      backup?.delete();
      throw error;
    }
    const adopted: Adopted[] = [];
    let current: TopoDS_Shape;
    // Whether `current` is the outcome of a merge, not just the backup.
    let merged = first.valid;
    if (first.valid) {
      adopted.push({ unify: first.unify, history: first.unify.History() });
      current = first.shape;
    } else if (backup) {
      adopted.push({ unify: null, history: SameDomainMerge.copyHistory(shape, backup) });
      current = backup.Shape();
    } else {
      current = shape;
    }
    backup?.delete();

    if (risky) {
      const tried = new Map<string, Set<string>>();
      const givenUp = new Set<string>();
      for (let retries = 0; retries < SameDomainMerge.MAX_RETRIES;) {
        const groups = SameDomainMerge.stuckGroups(current, options, false);
        const group = groups.find(g => !givenUp.has(SameDomainMerge.faceKey(g, g.members[0])));
        if (!group) {
          break;
        }
        const key = SameDomainMerge.faceKey(group, group.members[0]);
        let triedFaces = tried.get(key);
        if (!triedFaces) {
          triedFaces = new Set([key]);
          tried.set(key, triedFaces);
        }
        const reference = SameDomainMerge.nextReference(group, triedFaces);
        if (reference === null) {
          givenUp.add(key);
          continue;
        }
        triedFaces.add(SameDomainMerge.faceKey(group, reference));
        retries++;

        const last = groups
          .filter(g => g.shell.IsSame(group.shell) && givenUp.has(SameDomainMerge.faceKey(g, g.members[0])))
          .flatMap(g => g.members);
        const body = SameDomainMerge.bodyOf(current, group.shell);
        const reordered = SameDomainMerge.replace(body, group.shell, SameDomainMerge.reorderedShell(group, reference, last));
        const retry = SameDomainMerge.retry(body, reordered, options);
        if (retry) {
          adopted.push(retry.adopted);
          current = SameDomainMerge.replace(current, body, retry.shape);
          merged = true;
        }
      }
    }

    if (!merged) {
      for (const step of adopted) {
        step.history.delete();
      }
      return {
        shape: first.shape,
        valid: false,
        history: first.unify.History(),
        dispose: () => first.unify.delete(),
      };
    }
    if (!first.valid) {
      first.unify.delete();
    }

    const history = adopted[0].history;
    for (const next of adopted.slice(1)) {
      history.Merge(next.history);
      next.history.delete();
    }
    return {
      shape: current,
      valid: true,
      history,
      dispose: () => {
        history.delete();
        for (const step of adopted) {
          step.unify?.delete();
        }
      },
    };
  }

  private static pass(shape: TopoDS_Shape, options: SameDomainMergeOptions, check = true): Pass {
    const oc = getOC();
    const unify = new oc.ShapeUpgrade_UnifySameDomain(
      shape, options.unifyEdges, options.unifyFaces, options.concatBSplines ?? false);
    if (options.linearTolerance !== undefined) {
      unify.SetLinearTolerance(options.linearTolerance);
    }
    if (options.angularTolerance !== undefined) {
      unify.SetAngularTolerance(options.angularTolerance);
    }
    if (options.safeInput !== undefined) {
      unify.SetSafeInputMode(options.safeInput);
    }
    if (options.allowInternalEdges !== undefined) {
      unify.AllowInternalEdges(options.allowInternalEdges);
    }
    unify.Build();
    const result = unify.Shape();
    if (!check) {
      return { unify, shape: result, valid: true };
    }
    const checker = new oc.BRepCheck_Analyzer(result, true, true);
    const valid = checker.IsValid();
    checker.delete();
    return { unify, shape: result, valid };
  }

  /**
   * One retry: a pass over a copy of `reordered` — `body` with its faces in
   * another order — adopted when it is valid and left fewer faces than
   * `body` has. The lineage runs from `body`'s sub-shapes through the copy
   * into the merged result.
   */
  private static retry(
    body: TopoDS_Shape,
    reordered: TopoDS_Shape,
    options: SameDomainMergeOptions,
  ): { shape: TopoDS_Shape; adopted: Adopted } | null {
    const oc = getOC();
    const copier = new oc.BRepBuilderAPI_Copy(reordered, false, false);
    let pass: Pass | null = null;
    try {
      try {
        pass = SameDomainMerge.pass(copier.Shape(), options);
      } catch {
        // A reference the kernel chokes on is one more that does not merge.
        return null;
      }
      if (!pass.valid || SameDomainMerge.faceCount(pass.shape) >= SameDomainMerge.faceCount(body)) {
        pass.unify.delete();
        return null;
      }

      const history = SameDomainMerge.copyHistory(body, copier);
      const merged = pass.unify.History();
      history.Merge(merged);
      merged.delete();
      return { shape: pass.shape, adopted: { unify: pass.unify, history } };
    } finally {
      copier.delete();
    }
  }

  /** The lineage from `shape`'s faces, edges and vertices to their copies. */
  private static copyHistory(shape: TopoDS_Shape, copier: BRepBuilderAPI_Copy): BRepTools_History {
    const history = new (getOC().BRepTools_History)();
    for (const kind of ['face', 'edge', 'vertex'] as const) {
      for (const sub of Explorer.findShapes(shape, Explorer.getOcShapeType(kind) as TopAbs_ShapeEnum)) {
        history.AddModified(sub, copier.ModifiedShape(sub));
      }
    }
    return history;
  }

  private static faceCount(shape: TopoDS_Shape): number {
    const FACE = getOC().TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    return Explorer.findShapes(shape, FACE).length;
  }

  /**
   * The groups of adjacent faces that lie on one surface, per shell, each
   * shell's groups ordered by their first face. Surfaces are compared within
   * the tolerances the merge itself runs with, so a pair the kernel does not
   * consider same-domain is not reported. `periodicOnly` leaves the planar
   * groups out — those the kernel always merges.
   */
  private static stuckGroups(shape: TopoDS_Shape, options: SameDomainMergeOptions, periodicOnly: boolean): StuckGroup[] {
    const oc = getOC();
    const SHELL = oc.TopAbs_ShapeEnum.TopAbs_SHELL as TopAbs_ShapeEnum;
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    const kernel = SurfaceFrames.kernelTolerance();
    const tolerance: SurfaceTolerance = {
      lin: options.linearTolerance ?? kernel.lin,
      ang: options.angularTolerance ?? kernel.ang,
    };
    const groups: StuckGroup[] = [];

    for (const shell of Explorer.findShapes(shape, SHELL)) {
      const faces = Explorer.findShapes(shell, FACE);
      const frames = faces.map(f => SurfaceFrames.of(f, periodicOnly));

      // Like faces sit next to each other once sorted by kind and by the one
      // scalar a shared surface must agree on, so only neighbours in that
      // order are compared.
      const scalar = (f: SurfaceFrame) =>
        f.type === 'plane' ? Math.abs(f.loc[0] * f.dir![0] + f.loc[1] * f.dir![1] + f.loc[2] * f.dir![2]) : f.radius;
      const order = faces.map((_, i) => i)
        .filter(i => frames[i] !== null)
        .sort((a, b) => frames[a]!.type.localeCompare(frames[b]!.type) || scalar(frames[a]!) - scalar(frames[b]!));
      // How far the axis (a sphere's centre) passes from the origin: equal
      // for a shared surface, and cheap enough to tell apart the many
      // like-sized cylinders of a drilled plate before the full comparison.
      const offsets = frames.map(f => {
        if (!f || f.type === 'plane') {
          return 0;
        }
        const along = f.dir ? f.loc[0] * f.dir[0] + f.loc[1] * f.dir[1] + f.loc[2] * f.dir[2] : 0;
        const d = f.dir ?? [0, 0, 0];
        return Math.hypot(f.loc[0] - along * d[0], f.loc[1] - along * d[1], f.loc[2] - along * d[2]);
      });
      const window = 10 * tolerance.lin;
      const pairs: [number, number][] = [];
      for (let a = 0; a < order.length; a++) {
        const fa = frames[order[a]]!;
        for (let b = a + 1; b < order.length; b++) {
          const fb = frames[order[b]]!;
          if (fb.type !== fa.type || scalar(fb) - scalar(fa) > window * (1 + Math.abs(scalar(fa)))) {
            break;
          }
          if (Math.abs(offsets[order[b]] - offsets[order[a]]) > window * (1 + offsets[order[a]])) {
            continue;
          }
          if (SurfaceFrames.same(fa, fb, tolerance)) {
            pairs.push([order[a], order[b]]);
          }
        }
      }
      if (pairs.length === 0) {
        continue;
      }

      // Union the pairs that share an edge.
      const hasher = new ShapeHasher();
      const edgeKeys = new Map<number, Set<number>>();
      const edgesOf = (i: number) => {
        let keys = edgeKeys.get(i);
        if (!keys) {
          keys = new Set(Explorer.findShapes(faces[i], EDGE).map(e => hasher.key(e)));
          edgeKeys.set(i, keys);
        }
        return keys;
      };
      const parent = new Map<number, number>();
      const find = (i: number): number => {
        const p = parent.get(i);
        if (p === undefined || p === i) {
          return i;
        }
        const root = find(p);
        parent.set(i, root);
        return root;
      };
      for (const [i, j] of pairs) {
        const mine = edgesOf(i);
        let adjacent = false;
        for (const key of edgesOf(j)) {
          if (mine.has(key)) {
            adjacent = true;
            break;
          }
        }
        if (adjacent) {
          const ri = find(i);
          const rj = find(j);
          parent.set(ri, ri);
          parent.set(rj, ri);
        }
      }
      hasher.delete();

      const byRoot = new Map<number, number[]>();
      for (const i of parent.keys()) {
        const root = find(i);
        const members = byRoot.get(root);
        if (members) {
          members.push(i);
        } else {
          byRoot.set(root, [i]);
        }
      }
      const shellGroups = [...byRoot.values()]
        .map(members => members.sort((a, b) => a - b))
        .sort((a, b) => a[0] - b[0]);
      for (const members of shellGroups) {
        groups.push({ shell, faces, frames, members });
      }
    }
    return groups;
  }

  /**
   * Identifies a face across retries by its surface and extent. A rejected
   * retry leaves the shape as it was, so the same group comes back with the
   * same faces — and the key of its first one names the group.
   */
  private static faceKey(group: StuckGroup, index: number): string {
    const oc = getOC();
    const bounds = oc.BRepTools.UVBounds(oc.TopoDS.Face(group.faces[index]));
    const extent = [bounds.UMin, bounds.UMax, bounds.VMin, bounds.VMax].map(v => v.toFixed(6)).join(',');
    return `${SameDomainMerge.parametrization(group.frames[index]!)}|${extent}`;
  }

  /**
   * The next member to merge the group onto, or null when it has had its
   * share of tries. Which member works depends on where each one's surface
   * starts its period relative to the others, so a member on a surface no
   * tried reference used goes first, then the remaining members in order.
   */
  private static nextReference(group: StuckGroup, triedFaces: Set<string>): number | null {
    // The first entry is the reference the kernel picked on its own.
    if (triedFaces.size > SameDomainMerge.MAX_REFERENCES) {
      return null;
    }
    const untried = group.members.filter(m => !triedFaces.has(SameDomainMerge.faceKey(group, m)));
    if (untried.length === 0) {
      return null;
    }
    const triedSurfaces = new Set(group.members
      .filter(m => triedFaces.has(SameDomainMerge.faceKey(group, m)))
      .map(m => SameDomainMerge.parametrization(group.frames[m]!)));
    return untried.find(m => !triedSurfaces.has(SameDomainMerge.parametrization(group.frames[m]!))) ?? untried[0];
  }

  /** Two faces with the same key hand the kernel the same reference surface. */
  private static parametrization(frame: SurfaceFrame): string {
    const numbers = [frame.radius, frame.extra, ...frame.loc, ...(frame.dir ?? []), ...frame.xdir];
    return `${frame.type}|${numbers.map(v => v.toFixed(7)).join(',')}`;
  }

  /** The solid of `shape` that holds `shell`, or the shell itself when it is free. */
  private static bodyOf(shape: TopoDS_Shape, shell: TopoDS_Shape): TopoDS_Shape {
    const oc = getOC();
    const SOLID = oc.TopAbs_ShapeEnum.TopAbs_SOLID as TopAbs_ShapeEnum;
    const SHELL = oc.TopAbs_ShapeEnum.TopAbs_SHELL as TopAbs_ShapeEnum;
    for (const solid of Explorer.findShapes(shape, SOLID)) {
      if (Explorer.findShapes(solid, SHELL).some(s => s.IsSame(shell))) {
        return solid;
      }
    }
    return shell;
  }

  /** A copy of the group's shell listing `first` before every other face and the `last` faces after them. */
  private static reorderedShell(group: StuckGroup, first: number, last: number[]): TopoDS_Shape {
    const oc = getOC();
    const atEnd = new Set(last);
    const order = [
      first,
      ...group.faces.map((_, i) => i).filter(i => i !== first && !atEnd.has(i)),
      ...last.filter(i => i !== first),
    ];
    // BRep_Builder::Add stores a child relative to its parent; the faces
    // were read with the shell's orientation and location composed in.
    const builder = new oc.BRep_Builder();
    const copy = group.shell.EmptyCopied();
    for (const index of order) {
      builder.Add(copy, group.faces[index]);
    }
    copy.Closed(group.shell.Closed());
    builder.delete();
    return copy;
  }

  /**
   * `shape` with its sub-shape `target` swapped for `replacement`. Only the
   * containers above `target` are copied; everything else keeps its TShape.
   */
  private static replace(shape: TopoDS_Shape, target: TopoDS_Shape, replacement: TopoDS_Shape): TopoDS_Shape {
    const oc = getOC();
    const containers: TopAbs_ShapeEnum[] = [
      oc.TopAbs_ShapeEnum.TopAbs_COMPOUND,
      oc.TopAbs_ShapeEnum.TopAbs_COMPSOLID,
      oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    ];
    const builder = new oc.BRep_Builder();

    // Children are read with the parent's orientation and location composed
    // in, which is how BRep_Builder::Add expects to be handed them.
    const rebuild = (current: TopoDS_Shape): TopoDS_Shape => {
      if (current.IsSame(target)) {
        return replacement;
      }
      if (!containers.includes(current.ShapeType())) {
        return current;
      }
      const children: TopoDS_Shape[] = [];
      const iterator = new oc.TopoDS_Iterator(current, true, true);
      for (; iterator.More(); iterator.Next()) {
        children.push(iterator.Value());
      }
      iterator.delete();
      const rebuilt = children.map(rebuild);
      if (rebuilt.every((child, i) => child === children[i])) {
        return current;
      }
      const copy = current.EmptyCopied();
      for (const child of rebuilt) {
        builder.Add(copy, child);
      }
      return copy;
    };

    try {
      return rebuild(shape);
    } finally {
      builder.delete();
    }
  }
}
