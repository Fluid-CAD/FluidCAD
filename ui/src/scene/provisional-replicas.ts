import { Color, Group, Line, LineSegments, Material, Mesh, Object3D, Points } from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineResolutionRegistry } from '../meshes/shape-meshes/line-resolution';
import type { MateRecord } from '../solver';

/**
 * The replicate dialog's live preview, as the controller solves it: one
 * entry per complete row, each cloning the seed's bodies (an instance seed
 * is one body; an occurrence seed is every instance under its path) under
 * provisional ids and carrying the row's mates — the seed's internal mates
 * remapped onto the clones plus its outer mates re-targeted onto the row's
 * cells. Ids never collide with scene ids (see `provisionalReplicaId`).
 */
export type ProvisionalReplicaSpec = {
  rows: {
    clones: { sourceInstanceId: string; provisionalId: string }[];
    mates: MateRecord[];
  }[];
};

/** The provisional body id for row `row`'s clone of `sourceInstanceId` — never a scene id. */
export function provisionalReplicaId(row: number, sourceInstanceId: string): string {
  return `__replica-preview-${row}__/${sourceInstanceId}`;
}

/** The provisional mate id for row `row`'s copy of `sourceMateId`. */
export function provisionalReplicaMateId(row: number, sourceMateId: string): string {
  return `__replica-preview-${row}__/${sourceMateId}`;
}

/** How far a ghost's colors move toward white (0 = the seed's own colors). */
const GHOST_LIGHTEN = 0.45;
/** A ghost's face/edge opacity — translucent, never hidden. */
const GHOST_OPACITY = 0.55;

/**
 * A ghost of an instance group: the same geometry (shared — never dispose
 * it through the ghost) under fresh plain three.js nodes with cloned,
 * lightened, translucent materials, connectors dropped, every node flagged
 * a meta shape (the viewer's face/edge raycast skips it) and no instance
 * identity (the controller's drag pick never claims it).
 *
 * Walks the hierarchy by hand rather than `Object3D.clone()`: the scene's
 * mesh containers (`ShapeGroup`, `SolidMesh`, `FaceMesh`, `EdgeMesh`) are
 * Group subclasses whose constructors take the shape data, and three's
 * `clone()` re-invokes the constructor with no arguments.
 */
export function buildGhostClone(source: Group): Group {
  const clone = ghostNode(source) ?? new Group();
  clone.name = 'provisional-replica';
  clone.userData = { provisional: true, draggable: false, isMetaShape: true };
  return clone as Group;
}

type Renderable = Object3D & { geometry?: unknown; material?: Material | Material[] };

function ghostNode(obj: Object3D): Object3D | null {
  if (obj.userData?.isConnector || (obj as Object3D & { isSprite?: boolean }).isSprite) {
    return null;
  }
  const out = ghostLeaf(obj as Renderable) ?? new Group();
  out.position.copy(obj.position);
  out.quaternion.copy(obj.quaternion);
  out.scale.copy(obj.scale);
  out.visible = obj.visible;
  out.renderOrder = obj.renderOrder;
  out.layers.mask = obj.layers.mask;
  out.userData = { isMetaShape: true, provisional: true };
  for (const child of obj.children) {
    const ghost = ghostNode(child);
    if (ghost) {
      out.add(ghost);
    }
  }
  return out;
}

/** A fresh plain node of the same renderable kind, sharing geometry, with ghost materials; null for containers. */
function ghostLeaf(obj: Renderable): Object3D | null {
  const material = obj.material;
  if (!material || obj.geometry === undefined) {
    return null;
  }
  const ghost = Array.isArray(material) ? material.map(ghostMaterial) : ghostMaterial(material);
  const flags = obj as Object3D & {
    isMesh?: boolean; isLineSegments2?: boolean; isLine2?: boolean; isLineSegments?: boolean; isLine?: boolean; isPoints?: boolean;
  };
  // Fat lines extend Mesh — test them before the plain-mesh case.
  if (flags.isLine2) {
    return new Line2(obj.geometry as Line2['geometry'], ghost as LineMaterial);
  }
  if (flags.isLineSegments2) {
    return new LineSegments2(obj.geometry as LineSegments2['geometry'], ghost as LineMaterial);
  }
  if (flags.isMesh) {
    return new Mesh(obj.geometry as Mesh['geometry'], ghost as Mesh['material']);
  }
  if (flags.isLineSegments) {
    return new LineSegments(obj.geometry as LineSegments['geometry'], ghost as LineSegments['material']);
  }
  if (flags.isLine) {
    return new Line(obj.geometry as Line['geometry'], ghost as Line['material']);
  }
  if (flags.isPoints) {
    return new Points(obj.geometry as Points['geometry'], ghost as Points['material']);
  }
  return null;
}

/** A lightened, translucent copy of one material (shader uniforms included). */
function ghostMaterial(material: Material): Material {
  const ghost = material.clone();
  const white = new Color(0xffffff);
  const plain = ghost as Material & { color?: Color; opacity: number; resolution?: unknown };
  if (plain.color instanceof Color) {
    plain.color.lerp(white, GHOST_LIGHTEN);
  }
  const uniforms = (ghost as Material & { uniforms?: Record<string, { value: unknown }> }).uniforms;
  if (uniforms) {
    const color = uniforms.color?.value;
    if (color instanceof Color) {
      color.lerp(white, GHOST_LIGHTEN);
    }
    if (typeof uniforms.opacity?.value === 'number') {
      uniforms.opacity.value = Math.min(uniforms.opacity.value, GHOST_OPACITY);
    }
  }
  ghost.transparent = true;
  ghost.opacity = Math.min(plain.opacity, GHOST_OPACITY);
  ghost.depthWrite = false;
  // Fat-line materials read the viewport size from a uniform the registry
  // keeps current — a cloned one must join it or it goes stale on resize.
  if ((ghost as Material & { isLineMaterial?: boolean }).isLineMaterial) {
    LineResolutionRegistry.register(ghost as LineMaterial);
  }
  return ghost;
}
