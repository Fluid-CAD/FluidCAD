import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { Explorer } from "./explorer.js";
import { MM_PER_UNIT } from "../units/units.js";
import type { LengthUnit } from "../units/units.js";
import { getActiveUnit } from "../units/registry.js";

export interface MeshData {
  vertices: number[];
  normals: number[];
  indices: number[];
  count?: number;
}

/**
 * The resolved per-call mesher input: an absolute linear deflection in the
 * shape's own unit plus an angular deflection in radians. Callers that know
 * exactly what they want pass one of these; everything scene-driven resolves
 * it from a {@link MeshQuality} per shape.
 */
export interface MeshConfig {
  linDefl: number;
  angDefl: number;
}

export type MeshPreset = 'draft' | 'standard' | 'fine';

/**
 * Size- and unit-aware mesh density. One absolute deflection cannot serve a
 * 2 mm pin and a 2 m frame (nor an inch document and a millimetre one), so
 * the linear deflection is a fraction of the shape's bounding-box diagonal,
 * clamped to a floor/ceiling authored in millimetres and converted to the
 * shape's unit at resolve time. The angular deflection is scale-free.
 */
export interface MeshQuality {
  preset: MeshPreset | 'custom';
  /** Linear deflection as a fraction of the shape's bbox diagonal. */
  relative: number;
  /** Floor for the linear deflection, in mm. */
  minMm: number;
  /** Ceiling for the linear deflection, in mm. */
  maxMm: number;
  /** Angular deflection, radians. */
  angularRad: number;
}

/**
 * `standard` reproduces today's look on a 100–300 mm part and is visibly
 * better on small ones; `draft` trades detail for speed on big scenes;
 * `fine` is for export-grade output.
 */
export const MESH_PRESETS: Record<MeshPreset, MeshQuality> = {
  draft: { preset: 'draft', relative: 2e-3, minMm: 0.02, maxMm: 1.0, angularRad: 0.5 },
  standard: { preset: 'standard', relative: 5e-4, minMm: 0.005, maxMm: 0.5, angularRad: 0.35 },
  fine: { preset: 'fine', relative: 1e-4, minMm: 0.001, maxMm: 0.1, angularRad: 0.2 },
};

export const DEFAULT_MESH_QUALITY: MeshQuality = MESH_PRESETS.standard;

/** What the renderer, the mesh builder and the ghost path accept. */
export type MeshSettings = MeshQuality | MeshConfig;

export function isMeshQuality(settings: MeshSettings): settings is MeshQuality {
  return 'preset' in settings;
}

/**
 * A fixed `MeshConfig` expressed as a quality: `relative` 0 with floor and
 * ceiling both pinned to the deflection, so resolving it in any unit yields
 * the same physical deflection. `unit` says which unit `linDefl` is in.
 */
export function meshQualityFromConfig(config: MeshConfig, unit: LengthUnit): MeshQuality {
  const linDeflMm = config.linDefl * MM_PER_UNIT[unit];
  return { preset: 'custom', relative: 0, minMm: linDeflMm, maxMm: linDeflMm, angularRad: config.angDefl };
}

/** Normalise either accepted shape to a quality; a bare config counts in `unit`. */
export function toMeshQuality(settings: MeshSettings, unit: LengthUnit = getActiveUnit()): MeshQuality {
  return isMeshQuality(settings) ? settings : meshQualityFromConfig(settings, unit);
}

/** `clamp(diagonal × relative, minMm / f, maxMm / f)` with `f = MM_PER_UNIT[unit]`. */
export function resolveLinearDeflection(diagonal: number, quality: MeshQuality, unit: LengthUnit): number {
  const f = MM_PER_UNIT[unit];
  const lo = quality.minMm / f;
  const hi = quality.maxMm / f;
  const wanted = Number.isFinite(diagonal) && diagonal > 0 ? diagonal * quality.relative : 0;
  return Math.min(hi, Math.max(lo, wanted));
}

export function resolveMeshConfig(diagonal: number, quality: MeshQuality, unit: LengthUnit): MeshConfig {
  return { linDefl: resolveLinearDeflection(diagonal, quality, unit), angDefl: quality.angularRad };
}

/** Bounding-box diagonal; 0 for a void box (an empty compound has no corners). */
export function bboxDiagonal(shape: TopoDS_Shape): number {
  const oc = getOC();
  const box = new oc.Bnd_Box();
  try {
    oc.BRepBndLib.Add(shape, box, true);
    // Bnd_Box.IsVoid is not bound; CornerMin throws Standard_ConstructionError
    // on a void box, which is the only failure mode here.
    const min = box.CornerMin();
    const max = box.CornerMax();
    const diagonal = Math.hypot(max.X() - min.X(), max.Y() - min.Y(), max.Z() - min.Z());
    min.delete();
    max.delete();
    return Number.isFinite(diagonal) ? diagonal : 0;
  } catch {
    return 0;
  } finally {
    box.delete();
  }
}

/**
 * Size bucket of a diagonal: `round(log10(diagonal))`. Shapes in one bucket
 * are meshed together at one deflection, so a pin never inherits a plate's.
 * Degenerate diagonals land in bucket 0 (the floor clamps them anyway).
 */
export function meshSizeBucket(diagonal: number): number {
  if (!Number.isFinite(diagonal) || diagonal <= 0) {
    return 0;
  }
  return Math.round(Math.log10(diagonal));
}

/**
 * The diagonal a bucket is meshed at: its geometric centre `10^bucket`. A
 * member's true diagonal is within √10 either side, so its effective relative
 * deflection stays within √10 of the preset; using the bucket's upper edge
 * instead would let the smallest members drift a full 10× coarser.
 */
export function bucketDiagonal(bucket: number): number {
  return Math.pow(10, bucket);
}

/**
 * The exact size-aware config for one shape (its own diagonal, no bucket
 * quantisation) — for export (STL) and measurement, where the shape stands
 * alone. The renderer uses {@link resolveRenderMeshConfig} instead.
 */
export function resolveMeshConfigFor(shape: TopoDS_Shape | Shape, quality: MeshQuality, unit: LengthUnit = getActiveUnit()): MeshConfig {
  const raw = shape instanceof Shape ? shape.getShape() : shape;
  return resolveMeshConfig(bboxDiagonal(raw), quality, unit);
}

/**
 * The config the renderer meshes `shape` at: resolved from its size bucket,
 * not its exact diagonal. The batch mesher triangulates a whole bucket's
 * compound at one deflection; the per-shape path afterwards must ask for the
 * very same value or `BRepTools.Triangulation`'s "already meshed at ≤ this
 * deflection" check fails and every shape is re-meshed one by one.
 */
export function resolveRenderMeshConfig(shape: TopoDS_Shape | Shape, quality: MeshQuality, unit: LengthUnit = getActiveUnit()): MeshConfig {
  const raw = shape instanceof Shape ? shape.getShape() : shape;
  return resolveMeshConfig(bucketDiagonal(meshSizeBucket(bboxDiagonal(raw))), quality, unit);
}

/**
 * The fallback for callers that mesh without a scene: the standard preset
 * resolved for a typical ~150 mm part, in millimetres. Scene-driven paths
 * resolve per shape and never read this.
 */
export const DEFAULT_MESH_CONFIG: MeshConfig = resolveMeshConfig(150, DEFAULT_MESH_QUALITY, 'mm');

export interface EnsureTriangulatedOptions {
  linDefl?: number;
  angDefl?: number;
  parallel?: boolean;
  relative?: boolean;
  checkFreeEdges?: boolean;
}

export class Mesh {
  // Wrapper methods (public API for external callers)
  static triangulateFace(face: Face, vertexOffset: number = 0, opts?: EnsureTriangulatedOptions): MeshData | null {
    return Mesh.triangulateFaceRaw(face.getShape() as TopoDS_Face, vertexOffset, opts);
  }

  static discretizeEdge(edge: Shape, opts?: EnsureTriangulatedOptions): MeshData {
    return Mesh.discretizeEdgeRaw(edge.getShape(), opts);
  }

  /**
   * Triangulates `shape` only if it doesn't already have an up-to-date
   * triangulation at the requested deflection. Returns true when a fresh
   * mesh was built, false when the stored one was reused.
   */
  static ensureTriangulated(shape: TopoDS_Shape, opts: EnsureTriangulatedOptions = {}): boolean {
    const oc = getOC();
    const linDefl = opts.linDefl ?? DEFAULT_MESH_CONFIG.linDefl;
    const angDefl = opts.angDefl ?? DEFAULT_MESH_CONFIG.angDefl;
    const relative = opts.relative ?? false;
    const checkFreeEdges = opts.checkFreeEdges ?? true;

    if (oc.BRepTools.Triangulation(shape, linDefl, checkFreeEdges)) {
      return false;
    }

    console.log('Triangulating shape of type', Explorer.getShapeType(shape))
    const inc = new oc.BRepMesh_IncrementalMesh(shape, linDefl, relative, angDefl, true);
    inc.delete();
    return true;
  }

  // Raw methods (for oc-internal use)
  static triangulateFaceRaw(face: TopoDS_Face, vertexOffset: number = 0, opts?: EnsureTriangulatedOptions): MeshData | null {
    try {
      Mesh.ensureTriangulated(face, opts);
    } catch (e) {
      console.error("Face mesh failed", e);
      return null;
    }

    return Mesh.extractFaceTriangulationRaw(face, vertexOffset);
  }

  static extractFaceTriangulationRaw(face: TopoDS_Face, vertexOffset: number = 0): MeshData | null {
    const oc = getOC();

    const vertices: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];

    const aLocation = new oc.TopLoc_Location();
    // A null OCCT Handle arrives as JS `null` — embind maps null smart pointers
    // to null rather than to a wrapper — so there is nothing to call IsNull()
    // on. Test the value itself; `handle.isNull()` would throw here, turning
    // "this face has no triangulation" into an opaque TypeError.
    const triangulation = oc.BRep_Tool.Triangulation(face, aLocation, 0);
    if (!triangulation) {
      aLocation.delete();
      return null;
    }

    const pc = new oc.Poly_Connect(triangulation);
    const nbNodes = triangulation.NbNodes();

    for (let i = 1; i <= nbNodes; i++) {
      const t1 = aLocation.Transformation();
      const p = triangulation.Node(i);
      const p1 = p.Transformed(t1);
      vertices.push(p1.X(), p1.Y(), p1.Z());
      p.delete();
      p1.delete();
      t1.delete();
    }

    // OCCT 8.0: StdPrs_ToolTriangulatedShape (TKV3d) is gone; the surface-normals
    // utility moved to BRepLib_ToolTriangulatedShape (TKTopAlgo). It computes nodal
    // normals into the triangulation itself (no-op if it already has them), which we
    // then read back via Poly_Triangulation.Normal(i).
    oc.BRepLib_ToolTriangulatedShape.ComputeNormals(face, triangulation, pc);

    // A triangulation stores normals in the natural orientation of the
    // underlying surface, NOT the face's topological orientation. For a
    // TopAbs_REVERSED face the outward normal is the opposite of the surface
    // normal, so we must flip the nodal normals here. (Pre-OCCT-8 this was done
    // internally by StdPrs_ToolTriangulatedShape::Normal; BRepLib_ToolTriangulatedShape
    // ::ComputeNormals does not, which left reversed faces shaded as if lit from
    // inside the solid — they rendered dark.) The triangle winding below is
    // swapped under the same condition so winding and shading normals agree.
    const orient = face.Orientation();
    const reversed = orient !== oc.TopAbs_Orientation.TopAbs_FORWARD;

    for (let i = 1; i <= nbNodes; i++) {
      const t1 = aLocation.Transformation();
      const d1 = triangulation.Normal(i);
      const d = d1.Transformed(t1);
      if (reversed) {
        normals.push(-d.X(), -d.Y(), -d.Z());
      } else {
        normals.push(d.X(), d.Y(), d.Z());
      }
      d1.delete();
      d.delete();
      t1.delete();
    }

    const triangles = triangulation.Triangles();
    for (let nt = 1; nt <= triangulation.NbTriangles(); nt++) {
      const t = triangles.Value(nt);
      let n1 = t.Value(1) - 1;
      let n2 = t.Value(2) - 1;
      let n3 = t.Value(3) - 1;
      if (reversed) {
        [n1, n2] = [n2, n1];
      }
      indices.push(vertexOffset + n1, vertexOffset + n2, vertexOffset + n3);
      t.delete();
    }

    pc.delete();
    triangles.delete();
    triangulation.delete();
    aLocation.delete();

    return { vertices, normals, indices, count: nbNodes };
  }

  /**
   * Reads the polyline stored for `edge` as a polygon-on-triangulation of
   * `face`. Node indices point into the face's triangulation, so the edge
   * samples coincide exactly with the face mesh vertices (watertight).
   */
  static discretizeEdgeOnFace(edge: TopoDS_Edge, face: TopoDS_Face): MeshData | null {
    const oc = getOC();
    if (oc.BRep_Tool.Degenerated(edge)) {
      return null;
    }

    const loc = new oc.TopLoc_Location();
    // Null handles come back as JS `null`, not as a wrapper — see
    // `extractFaceTriangulationRaw`. There is nothing to delete on that path.
    const tri = oc.BRep_Tool.Triangulation(face, loc, 0);
    if (!tri) {
      loc.delete();
      return null;
    }

    const poly = oc.BRep_Tool.PolygonOnTriangulation(edge, tri, loc);
    if (!poly) {
      tri.delete();
      loc.delete();
      return null;
    }

    const nbNodes = poly.NbNodes();
    const tx = loc.Transformation();

    const vertices: number[] = new Array(nbNodes * 3);
    for (let i = 1; i <= nbNodes; i++) {
      const nodeIdx = poly.Node(i);
      const p = tri.Node(nodeIdx);
      const pT = p.Transformed(tx);
      const base = (i - 1) * 3;
      vertices[base] = pT.X();
      vertices[base + 1] = pT.Y();
      vertices[base + 2] = pT.Z();
      p.delete();
      pT.delete();
    }

    const indices: number[] = new Array((nbNodes - 1) * 2);
    for (let i = 0; i < nbNodes - 1; i++) {
      indices[i * 2] = i;
      indices[i * 2 + 1] = i + 1;
    }

    tx.delete();
    poly.delete();
    tri.delete();
    loc.delete();

    return { vertices, normals: [], indices };
  }

  /**
   * Reads the stored 3D polygon for a free edge (one not attached to a
   * meshed face). Caller must have already run `ensureTriangulated` on the
   * edge or its parent wire.
   */
  static discretizeEdgeRaw(edge: TopoDS_Shape, opts?: EnsureTriangulatedOptions): MeshData {
    const oc = getOC();
    const ocEdge = oc.TopoDS.Edge(edge);

    if (oc.BRep_Tool.Degenerated(ocEdge)) {
      ocEdge.delete();
      return { vertices: [], normals: [], indices: [] };
    }

    Mesh.ensureTriangulated(edge, opts);

    const loc = new oc.TopLoc_Location();
    const poly = oc.BRep_Tool.Polygon3D(ocEdge, loc);
    if (!poly) {
      loc.delete();
      ocEdge.delete();
      console.warn("Edge has no stored Polygon3D after meshing; returning empty polyline.");
      return { vertices: [], normals: [], indices: [] };
    }

    const nbNodes = poly.NbNodes();
    const nodes = poly.Nodes();
    const tx = loc.Transformation();

    const vertices: number[] = new Array(nbNodes * 3);
    for (let i = 1; i <= nbNodes; i++) {
      const p = nodes.Value(i);
      const pT = p.Transformed(tx);
      const base = (i - 1) * 3;
      vertices[base] = pT.X();
      vertices[base + 1] = pT.Y();
      vertices[base + 2] = pT.Z();
      p.delete();
      pT.delete();
    }

    const indices: number[] = new Array((nbNodes - 1) * 2);
    for (let i = 0; i < nbNodes - 1; i++) {
      indices[i * 2] = i;
      indices[i * 2 + 1] = i + 1;
    }

    tx.delete();
    poly.delete();
    loc.delete();
    ocEdge.delete();

    return { vertices, normals: [], indices };
  }
}
