import type { BRepBuilderAPI_MakeShape, TopAbs_ShapeEnum, TopoDS_Shape, TopTools_IndexedMapOfShape, TopTools_MapOfShape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { ShapeOps } from "./shape-ops.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { FaceColorView } from "../common/face-color-view.js";
import type { SceneObject } from "../common/scene-object.js";
import type { CleanShapeLineage } from "./shape-ops.js";

/** A shape an operation consumes, with the colours its holder resolves for it. */
export type SourceColors = { shape: Shape; colors: FaceColorView };

/**
 * A colour an operation carried onto a face of one of its results, with the
 * statement that painted the source face it came from. The feature holding
 * `shape` records it (`SceneObject.recordCarriedColors`), which makes `face`
 * — a fresh wrapper the pass built — the scene's; a caller that drops a
 * record frees it instead (`ColorTransfer.disposeCarried`).
 */
export type CarriedColor = { shape: Shape; face: Face; color: string; setBy: SceneObject };

type Paint = { raw: TopoDS_Shape; color: string; setBy: SceneObject };

/**
 * The colours one pass places on one result shape, keyed by raw face
 * (`IsSame`). Seeds are what earlier passes carried and are answered but not
 * reported; `set` is what this pass adds — reported once per face, the last
 * write winning, as a wrapper's colour map once did. Owns native memory.
 */
class ResultColors {
  private readonly faces: TopTools_MapOfShape;
  private readonly keys: TopTools_IndexedMapOfShape;
  private readonly seeded = new Map<number, Paint>();
  private readonly placed = new Map<number, Paint>();

  constructor(readonly shape: Shape, seeds: ReadonlyArray<CarriedColor>) {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    this.faces = new oc.TopTools_MapOfShape();
    // The map keeps its own references; the explorer copies go.
    Explorer.withShapes(shape.getShape(), FACE, raws => {
      for (const raw of raws) {
        this.faces.Add(raw);
      }
    });
    this.keys = new oc.TopTools_IndexedMapOfShape();
    for (const seed of seeds) {
      if (seed.shape === shape) {
        this.seeded.set(this.keys.Add(seed.face.getShape()), { raw: seed.face.getShape(), color: seed.color, setBy: seed.setBy });
      }
    }
  }

  /** Whether `raw` is a face of this result. */
  has(raw: TopoDS_Shape): boolean {
    return this.faces.Contains(raw);
  }

  /** The colour already on `raw` — carried in or placed by this pass. */
  get(raw: TopoDS_Shape): Paint | undefined {
    const key = this.keys.FindIndex(raw);
    if (key === 0) {
      return undefined;
    }
    return this.placed.get(key) ?? this.seeded.get(key);
  }

  set(raw: TopoDS_Shape, color: string, setBy: SceneObject): void {
    this.placed.set(this.keys.Add(raw), { raw, color, setBy });
  }

  /** What this pass placed, as records for the result's holder. */
  carried(): CarriedColor[] {
    const out: CarriedColor[] = [];
    for (const paint of this.placed.values()) {
      out.push({
        shape: this.shape,
        face: Face.fromTopoDSFace(Explorer.toFace(paint.raw)),
        color: paint.color,
        setBy: paint.setBy,
      });
    }
    return out;
  }

  delete(): void {
    this.faces.delete();
    this.keys.delete();
    this.seeded.clear();
    this.placed.clear();
  }
}

/**
 * Carries face colours through kernel operations: for each painted source
 * face, finds where it ended up in the result shapes via `maker.Modified()`
 * (falling back to the unchanged face if `!IsDeleted`) and reports the
 * colour on whichever result shape now owns it, author kept.
 *
 * Colours are read from the sources' holders (`SourceColors`, built with
 * `SceneObject.getFaceColors`) and returned as `CarriedColor` records for
 * the feature holding the results to write; nothing here touches a shape.
 * Works for any `BRepBuilderAPI_MakeShape`-derived maker — fuse, cut,
 * fillet, chamfer, transform, etc.
 */
export class ColorTransfer {
  /** `shape` with no colours — for scratch inputs (ghosts, tests) the ops' signatures still ask for. */
  static plain(shape: Shape): SourceColors {
    return { shape, colors: new FaceColorView([]) };
  }

  /**
   * A view over the colours `carried` placed on `shape` — how a pass
   * chained after another (a cleanup after a maker) reads its input. The
   * caller deletes it.
   */
  static viewOf(carried: ReadonlyArray<CarriedColor>, shape: Shape): FaceColorView {
    return new FaceColorView(carried.filter(c => c.shape === shape));
  }

  /** Free the face wrappers of records nobody recorded (a dropped piece, a pre-clean pass read through and done with). */
  static disposeCarried(carried: Iterable<CarriedColor>): void {
    for (const record of carried) {
      record.face.dispose();
    }
  }

  /**
   * Carries the colours through `maker`. `remapFace` (a cleanup chained
   * after the maker) is handed the maker's images and answers with raw
   * copies this pass owns and frees; the images themselves go too, once the
   * records hold their own typed copies.
   */
  static applyThroughMaker(
    sources: SourceColors[],
    results: Shape[],
    maker: BRepBuilderAPI_MakeShape,
    remapFace?: (raw: TopoDS_Shape) => TopoDS_Shape[],
  ): CarriedColor[] {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    if (sources.every(source => source.colors.isEmpty())) {
      return [];
    }

    const placed = results.map(result => new ResultColors(result, []));
    // The raw copies this pass owns — the maker's image lists and the
    // remap's answers — keyed into the results' maps and freed with them.
    const scratch: TopoDS_Shape[] = [];
    try {
      for (const source of sources) {
        for (const entry of source.colors.entries()) {
          const raw = entry.face.getShape();
          const modifiedAll = ShapeOps.shapeListToArray(maker.Modified(raw));
          scratch.push(...modifiedAll);
          const modifiedRaws = modifiedAll.filter(s => s.ShapeType() === FACE);

          let targets: TopoDS_Shape[];
          if (modifiedRaws.length > 0) {
            targets = modifiedRaws;
          } else if (!maker.IsDeleted(raw)) {
            targets = [raw];
          } else {
            continue;
          }

          // A post-maker cleanup (UnifySameDomain) may rebuild faces again;
          // `remapFace` chains the maker's output onto the final faces so the
          // IsSame search below still lands.
          if (remapFace) {
            targets = targets.flatMap(remapFace);
            scratch.push(...targets);
          }

          for (const target of targets) {
            const owner = placed.find(result => result.has(target));
            if (owner) {
              owner.set(target, entry.color, entry.setBy);
            }
          }
        }
      }
      return placed.flatMap(result => result.carried());
    } finally {
      for (const result of placed) {
        result.delete();
      }
      Explorer.deleteAll(scratch);
    }
  }

  /**
   * Color bleed pass: spreads colors to result faces that came from new
   * geometry (tool inputs, generated faces, or just brand-new).
   *
   * Two passes, in order:
   *
   *   1. Lineage-based propagation. For each scene-source EDGE / VERTEX,
   *      ask `maker.Generated(input)` for the new face(s) it produced and
   *      color each generated face from the source face(s) that *contained*
   *      that input. This is what makes a fillet on a cylinder's top edge
   *      inherit the top face's color (the edge belongs to the top face) but
   *      a fillet on a box's vertical edge stay uncolored even when the top
   *      face is colored (the vertical edge belongs to two side faces only).
   *      Faces touched by this pass — colored OR not — are marked as
   *      lineage-resolved and excluded from pass 2.
   *
   *   2. Adjacency-based fallback for result faces that have no Generated
   *      lineage from any scene source (e.g. a fuse's tool-side faces, or
   *      brand-new section faces). These spread color via face-edge
   *      adjacency, iterating until stable. Faces that came from
   *      `sceneSources` (whether modified or unchanged) stay protected from
   *      both passes — those are explicit user choices.
   *
   * Call AFTER `applyThroughMaker`, handing its output in as `seeds`: the
   * colours already on the results, which bleeding spreads from and never
   * overwrites. A bled colour carries the author of the seed it spread
   * from. Returns only what this pass added.
   */
  static applyBleeding(
    sceneSources: SourceColors[],
    results: Shape[],
    maker: BRepBuilderAPI_MakeShape,
    remapFace?: (raw: TopoDS_Shape) => TopoDS_Shape[],
    seeds: ReadonlyArray<CarriedColor> = [],
  ): CarriedColor[] {
    if (sceneSources.every(source => source.colors.isEmpty())) {
      return [];
    }

    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    const VERTEX = oc.TopAbs_ShapeEnum.TopAbs_VERTEX as TopAbs_ShapeEnum;

    // Chain maker output through the post-maker cleanup (if any) so the
    // protected/generated sets are expressed in final faces.
    const toFinal = (raws: TopoDS_Shape[]) => (remapFace ? raws.flatMap(remapFace) : raws);

    // Every raw this pass reads — explorer copies, the maker's image lists,
    // the remap's answers — is keyed into kernel maps (which keep their own
    // references) or wrapped by `carried()` (which takes typed copies), so
    // each is freed once its pass is done with it.
    const protectedFaces = new oc.TopTools_MapOfShape();
    for (const scene of sceneSources) {
      Explorer.withShapes(scene.shape.getShape(), FACE, inputFaces => {
        for (const inputFace of inputFaces) {
          const modifiedAll = ShapeOps.shapeListToArray(maker.Modified(inputFace));
          const modified = modifiedAll.filter(s => s.ShapeType() === FACE);
          const finals = modified.length > 0
            ? toFinal(modified)
            : !maker.IsDeleted(inputFace) ? toFinal([inputFace]) : [];
          for (const r of finals) {
            protectedFaces.Add(r);
          }
          Explorer.deleteAll(modifiedAll);
          if (remapFace) {
            Explorer.deleteAll(finals);
          }
        }
      });
    }

    const bled: CarriedColor[] = [];
    for (const result of results) {
      const placed = new ResultColors(result, seeds);
      const scratch: TopoDS_Shape[] = [];
      const allFaces = Explorer.findShapes(result.getShape(), FACE);
      scratch.push(...allFaces);

      // ── Pass 1: lineage via Generated(edge|vertex) ──
      const lineageResolved = new oc.TopTools_MapOfShape();

      try {
        for (const scene of sceneSources) {
          const sceneFaces = Explorer.findShapes(scene.shape.getShape(), FACE);
          scratch.push(...sceneFaces);

          for (const subType of [EDGE, VERTEX] as TopAbs_ShapeEnum[]) {
            // Cache scene-face → contained subshapes so we can find which faces
            // own a given edge/vertex without re-walking each time.
            const sceneFaceSubs = sceneFaces.map(f => Explorer.findShapes(f, subType));
            const subs = Explorer.findShapes(scene.shape.getShape(), subType);

            try {
              for (const sub of subs) {
                const generatedAll = ShapeOps.shapeListToArray(maker.Generated(sub));
                scratch.push(...generatedAll);
                const generatedFaces = toFinal(generatedAll.filter(s => s.ShapeType() === FACE));
                if (remapFace) {
                  scratch.push(...generatedFaces);
                }
                if (generatedFaces.length === 0) {
                  continue;
                }

                // Color the generated face from the first colored owner-face of
                // this edge/vertex. Owners with no color don't contribute, so a
                // fillet on a vertical box edge (owned only by uncolored sides)
                // stays uncolored even though the new fillet face touches a
                // colored top via adjacency.
                let picked: { color: string; setBy: SceneObject } | undefined;
                for (let i = 0; i < sceneFaces.length; i++) {
                  if (!sceneFaceSubs[i].some(s => s.IsSame(sub))) {
                    continue;
                  }
                  const entry = scene.colors.entryOf(sceneFaces[i]);
                  if (entry) {
                    picked = entry;
                    break;
                  }
                }

                for (const g of generatedFaces) {
                  if (!placed.has(g)) {
                    continue;
                  }
                  if (protectedFaces.Contains(g)) {
                    continue;
                  }
                  lineageResolved.Add(g);
                  if (picked && !placed.get(g)) {
                    placed.set(g, picked.color, picked.setBy);
                  }
                }
              }
            } finally {
              for (const list of sceneFaceSubs) {
                Explorer.deleteAll(list);
              }
              Explorer.deleteAll(subs);
            }
          }
        }

        // ── Pass 2: adjacency fallback for faces with no Generated lineage ──
        const faceEdges = allFaces.map(f => Explorer.findShapes(f, EDGE));

        try {
          let changed = true;
          while (changed) {
            changed = false;
            for (let i = 0; i < allFaces.length; i++) {
              const face = allFaces[i];
              if (protectedFaces.Contains(face)) {
                continue;
              }
              if (lineageResolved.Contains(face)) {
                continue;
              }
              if (placed.get(face)) {
                continue;
              }

              const myEdges = faceEdges[i];
              for (let j = 0; j < allFaces.length; j++) {
                if (i === j) {
                  continue;
                }
                const otherEdges = faceEdges[j];
                const adjacent = myEdges.some(me => otherEdges.some(oe => me.IsSame(oe)));
                if (!adjacent) {
                  continue;
                }
                const other = placed.get(allFaces[j]);
                if (other) {
                  placed.set(face, other.color, other.setBy);
                  changed = true;
                  break;
                }
              }
            }
          }
        } finally {
          for (const list of faceEdges) {
            Explorer.deleteAll(list);
          }
        }

        bled.push(...placed.carried());
      } finally {
        lineageResolved.delete();
        placed.delete();
        Explorer.deleteAll(scratch);
      }
    }

    protectedFaces.delete();
    return bled;
  }

  /**
   * Transfer colors from a pre-clean source shape through a `cleanShapeWithLineage`
   * cleanup's `BRepTools_History` onto the post-clean result. Use this when an
   * op is chained as `maker → cleanShape` — first apply `applyThroughMaker` to
   * move colors from the original source onto the pre-clean result, then call
   * this (reading that output through `viewOf`) to chain them through the
   * cleanup's UnifySameDomain history.
   */
  static applyThroughCleanup(source: SourceColors, cleanup: CleanShapeLineage): CarriedColor[] {
    const carried: CarriedColor[] = [];
    for (const entry of source.colors.entries()) {
      const postFaces = cleanup.remapFace(entry.face);
      if (!postFaces) {
        continue;
      }
      for (const postFace of postFaces) {
        carried.push({ shape: cleanup.shape, face: postFace, color: entry.color, setBy: entry.setBy });
      }
    }
    return carried;
  }

  /**
   * Cut-path color propagation: each stock solid read through the boolean
   * that ran against it (`makerOf`), chained through UnifySameDomain's
   * history via the `cleanups[]` remapFace callbacks so colors land on the
   * actual post-clean faces in `cleanedShapes`.
   */
  static applyThroughCut(
    sources: SourceColors[],
    cleanedShapes: Shape[],
    makerOf: (stockShape: Shape) => BRepBuilderAPI_MakeShape,
    cleanups: CleanShapeLineage[],
  ): CarriedColor[] {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    if (sources.every(source => source.colors.isEmpty())) {
      return [];
    }

    const placed = cleanedShapes.map(cleaned => new ResultColors(cleaned, []));
    // The wrappers this pass walks the cleanups' lineage with — the maker's
    // pre-clean images and the fresh wrappers each remap answers — are its
    // own: the records take typed copies, so they go with the pass.
    const scratch: Shape[] = [];
    try {
      for (const source of sources) {
        if (source.colors.isEmpty()) {
          continue;
        }

        const maker = makerOf(source.shape);
        for (const entry of source.colors.entries()) {
          const raw = entry.face.getShape();
          const modifiedAll = ShapeOps.shapeListToArray(maker.Modified(raw));
          let preCleanFaces: Face[];
          try {
            const modifiedRaws = modifiedAll.filter(s => s.ShapeType() === FACE);
            if (modifiedRaws.length > 0) {
              preCleanFaces = modifiedRaws.map(r => Face.fromTopoDSFace(Explorer.toFace(r)));
            } else if (!maker.IsDeleted(raw)) {
              preCleanFaces = [Face.fromTopoDSFace(Explorer.toFace(raw))];
            } else {
              continue;
            }
          } finally {
            Explorer.deleteAll(modifiedAll);
          }
          scratch.push(...preCleanFaces);

          // Chain through each cleanup's UnifySameDomain lineage
          const postCleanFaces: Face[] = [];
          for (const preFace of preCleanFaces) {
            let matched = false;
            for (const cleanup of cleanups) {
              const remapped = cleanup.remapFace(preFace);
              if (remapped !== null) {
                postCleanFaces.push(...remapped);
                scratch.push(...remapped);
                matched = true;
                break;
              }
            }
            if (!matched) {
              postCleanFaces.push(preFace);
            }
          }

          for (const postFace of postCleanFaces) {
            const owner = placed.find(result => result.has(postFace.getShape()));
            if (owner) {
              owner.set(postFace.getShape(), entry.color, entry.setBy);
            }
          }
        }
      }
      return placed.flatMap(result => result.carried());
    } finally {
      for (const result of placed) {
        result.delete();
      }
      for (const face of scratch) {
        face.dispose();
      }
    }
  }
}
