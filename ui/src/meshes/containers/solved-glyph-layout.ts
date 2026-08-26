// Per-frame screen-space layout for solved-sketch annotations (P5.5).
//
// The glyph pass (sketch-solver-client/glyphs.ts) fixes anchors and local
// axes in sketch coordinates; this is the half that knows about pixels. Each
// zoom step it projects the sketch, runs the pure declutterer, and applies
// the answer: badge rows along their edges, dimension labels parked clear of
// each other, and read-only `+N` pills where a row had to collapse.
//
// Two things make it cheap enough to sit in the render loop:
//   * the layout depends only on ZOOM and camera ORIENTATION — panning moves
//     every anchor by the same offset, so it cannot change the answer. The
//     cache key quantizes both, and a steady camera costs one string compare
//     per frame;
//   * the sprites are camera-facing, so their drawn footprint IS the
//     axis-aligned box the declutterer reasoned about (a label ALIGNED with
//     its line — a diameter riding its chord — hands over the axis-aligned
//     bounds of its rolled box instead). No foreshortening correction, and
//     an oblique view stays as readable as a normal one.

import {
  BufferGeometry,
  Camera,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { PlaneData } from '../../types';
import type { SolvedSketchModel } from '../../sketch-solver-client';
import { tessellateSolvedEntity } from '../../sketch-solver-client';
import { GeometryIndex, declutterAnnotations } from '../../sketch-solver-client/declutter';
import type {
  BadgeItem,
  DimensionItem,
  DimensionStyle,
  Placement,
  Pt,
  Rect,
} from '../../sketch-solver-client/declutter';
import { localToWorld } from '../../interactive/sketch-plane-utils';
import { pixelScale, pixelsToWorld } from '../screen-scale';
import { getIconTexture } from './badge-textures';
import type { BoxPx, GlyphBox } from './glyph-box';

export type { BoxPx, GlyphBox } from './glyph-box';

export type Vec2 = [number, number];

/** Geometry units the glyph planes are authored in; the group scale maps
 * this to the target pixel height. */
export const GLYPH_PLANE_SIZE = 5;
export const BADGE_PX_SIZE = 16;
/** Dimension value readouts (distance/radius/diameter). This is the sprite
 * height, not the type size — the text texture fills ~0.7 of the canvas, so
 * the glyphs read a few px shorter than the number here. */
export const LABEL_PX_SIZE = 22;
export const ANGLE_LABEL_PX_SIZE = 22;
export const GLYPH_RENDER_ORDER = 3;
/** A label pushed further than this from its dimension line grows a link
 * back to it — past one rung the pairing stops being obvious. */
const LABEL_LINK_THRESHOLD_PX = 26;
const LINK_OPACITY = 0.4;
/** Entity samples fed to the geometry index. Enough to keep an arc's chord
 * error under a pixel at any sane zoom, cheap enough to reproject. */
const CURVE_SAMPLES = 24;
/** How far a label may slide down its own dimension line before it stops
 * reading as that dimension's value. */
const MAX_SLIDE_PX = 90;
/** Half reach of the cross registered in the geometry index for each solved
 * vertex/center dot: the drawn dot's 6 px radius plus a little clearance.
 * Dots are drag handles (and coincidence rings sit on them), so a badge
 * parked on one hides an affordance — the cross makes that spot score as
 * clutter like any curve. */
const VERTEX_CROSS_PX = 8;

/** A decluttered sprite: the layout owns its transform outright. */
export type LayoutSprite = {
  group: Group;
  anchorLocal: Vec2;
  anchorWorld: Vector3;
  placement: Placement;
  /** Target on-screen height. */
  pxSize: number;
  halfWidthPx: number;
  halfHeightPx: number;
};

export type BadgeSprite = LayoutSprite & {
  outLocal: Vec2;
  alongLocal: Vec2;
  /** Host edge length in sketch units (0 = no host edge). */
  span: number;
  groupKey: string;
  rank: number;
  order: number;
};

export type DimensionSprite = LayoutSprite & {
  pushLocal: Vec2;
  slideLocal: Vec2;
  style: DimensionStyle;
  /** One-way slide reach, sketch units. */
  slideRange: number;
  order: number;
  /** The dimension line this label belongs to, for the link stub. */
  leader: [Vec2, Vec2] | null;
  link: Line | null;
  /**
   * The rectangle this label is DRAWN as, owned by this pass and SHARED BY
   * REFERENCE with the glyph's hit target (like `placement`). An aligned
   * label rolls with its line, so both its offset and its angle change with
   * the camera and a pick frozen at build time would test a box the label
   * never covers.
   */
  box: GlyphBox;
};

/** Drawn elsewhere, but reserved so nothing lands on it (angle readouts). */
export type FixedAnnotation = {
  anchorWorld: Vector3;
  /** Local direction the readout sits along from its anchor. */
  dirLocal: Vec2;
  radiusPx: number;
  halfWidthPx: number;
  halfHeightPx: number;
  /** Kept current so the hit target follows the drawn position. */
  placement: Placement;
};

const _size = new Vector2();
const _ndc = new Vector3();
const _camRight = new Vector3();
const _camUp = new Vector3();
const _camFwd = new Vector3();
const _camQuat = new Quaternion();
const _roll = new Quaternion();
const _viewAxis = new Vector3(0, 0, 1);

/**
 * In-plane rotation (radians CCW, sprite-local) that lays a label along the
 * screen direction `d`. Screen y points down while the sprite's local y
 * points up, hence the negated component. Directions pointing left — or
 * straight down — are flipped first: a value must read left-to-right, and
 * bottom-to-top when its line is vertical (drafting reads a vertical
 * dimension from the right of the sheet).
 */
function rollFor(d: Pt): number {
  const flip = d.x < -1e-6 || (Math.abs(d.x) <= 1e-6 && d.y > 0);
  const x = flip ? -d.x : d.x;
  const y = flip ? -d.y : d.y;
  return Math.atan2(-y, x);
}

/** Axis-aligned bounds of a sprite's box once rolled — what the declutterer
 * reserves. (The hit target keeps the rolled box itself, so what picks stays
 * what is drawn.) */
function rolledBounds(sprite: LayoutSprite, roll: number): BoxPx {
  const c = Math.abs(Math.cos(roll));
  const s = Math.abs(Math.sin(roll));
  return {
    halfWidthPx: c * sprite.halfWidthPx + s * sprite.halfHeightPx,
    halfHeightPx: s * sprite.halfWidthPx + c * sprite.halfHeightPx,
  };
}

/** Local→screen linear map (px per sketch unit), plus the projected origin. */
type PlaneProjection = {
  originPx: Pt;
  ax: number; ay: number;
  bx: number; by: number;
};

function projectPx(world: Vector3, camera: Camera, width: number, height: number): Pt {
  _ndc.copy(world).project(camera);
  return { x: ((_ndc.x + 1) / 2) * width, y: ((1 - _ndc.y) / 2) * height };
}

function mapDir(p: PlaneProjection, d: Vec2): Pt {
  return { x: p.ax * d[0] + p.bx * d[1], y: p.ay * d[0] + p.by * d[1] };
}

function unitDir(p: PlaneProjection, d: Vec2, fallback: Pt): Pt {
  const v = mapDir(p, d);
  const len = Math.hypot(v.x, v.y);
  return len > 1e-6 ? { x: v.x / len, y: v.y / len } : fallback;
}

/**
 * Owns the screen-space placement of one solved sketch's annotations. Built
 * with the sketch's glyph meshes; re-solves the layout whenever the camera's
 * zoom or orientation bucket changes, then writes transforms straight onto
 * the sprite groups.
 */
export class SolvedGlyphLayout {
  /** Pills live here so the sketch mesh can add one child and forget. */
  readonly pillGroup = new Group();

  private pills: { group: Group; mesh: Mesh; material: MeshBasicMaterial }[] = [];
  private rowLinks: Line[] = [];
  private geometryLocal: Vec2[][] = [];
  /** Solved vertex/center dots — registered as point clutter per solve. */
  private dotsLocal: Vec2[] = [];
  private cacheKey = '';
  private pillColor: Color;

  constructor(
    private plane: PlaneData,
    private badges: BadgeSprite[],
    private dimensions: DimensionSprite[],
    private fixed: FixedAnnotation[],
    model: SolvedSketchModel,
    pillColor: Color,
  ) {
    this.pillColor = pillColor;
    this.pillGroup.renderOrder = GLYPH_RENDER_ORDER;
    this.pillGroup.userData.isConstraintIcon = true;
    for (const entity of model.entities.values()) {
      const points = tessellateSolvedEntity(entity, entity.kind === 'line' ? 1 : CURVE_SAMPLES);
      if (points && points.length > 1) {
        this.geometryLocal.push(points as Vec2[]);
      }
      for (const dot of [entity.point, entity.start, entity.end, entity.center]) {
        if (dot) {
          this.dotsLocal.push(dot);
        }
      }
    }
  }

  update(renderer: WebGLRenderer, camera: Camera): void {
    renderer.getSize(_size);
    const width = _size.x || renderer.domElement.clientWidth || 1;
    const height = _size.y || renderer.domElement.clientHeight || 1;
    const reference = this.badges[0]?.anchorWorld
      ?? this.dimensions[0]?.anchorWorld
      ?? this.fixed[0]?.anchorWorld
      ?? localToWorld([0, 0], this.plane);
    const worldPerPx = pixelsToWorld(renderer, camera, reference, 1);
    if (!(worldPerPx > 0) || !Number.isFinite(worldPerPx)) {
      return;
    }

    camera.getWorldQuaternion(_camQuat);
    const key = this.layoutKey(worldPerPx, width, height);
    if (key !== this.cacheKey) {
      this.cacheKey = key;
      this.solve(camera, width, height, worldPerPx);
    }
    this.applyTransforms(renderer, camera);
  }

  dispose(): void {
    for (const pill of this.pills) {
      pill.mesh.geometry.dispose();
      pill.material.dispose();
    }
    this.pills = [];
    for (const line of this.rowLinks) {
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
    }
    this.rowLinks = [];
    this.pillGroup.clear();
  }

  /**
   * Zoom bucket + camera orientation. Panning is deliberately absent: it
   * translates every anchor equally, so the relative layout — the only thing
   * this pass decides — cannot change.
   */
  private layoutKey(worldPerPx: number, width: number, height: number): string {
    const zoom = Math.round(Math.log(worldPerPx) * 24);
    const q = _camQuat;
    return `${zoom}|${width}|${height}|${Math.round(q.x * 256)},${Math.round(q.y * 256)},`
      + `${Math.round(q.z * 256)},${Math.round(q.w * 256)}`;
  }

  private planeProjection(camera: Camera, width: number, height: number, worldPerPx: number): PlaneProjection {
    // Probe with a span that lands ~100 px across, which keeps the finite
    // difference well conditioned at any zoom.
    const span = worldPerPx * 100;
    const origin = localToWorld([0, 0], this.plane);
    const o = projectPx(origin, camera, width, height);
    const x = projectPx(localToWorld([span, 0], this.plane), camera, width, height);
    const y = projectPx(localToWorld([0, span], this.plane), camera, width, height);
    return {
      originPx: o,
      ax: (x.x - o.x) / span,
      ay: (x.y - o.y) / span,
      bx: (y.x - o.x) / span,
      by: (y.y - o.y) / span,
    };
  }

  private solve(camera: Camera, width: number, height: number, worldPerPx: number): void {
    const projection = this.planeProjection(camera, width, height, worldPerPx);
    const project = (world: Vector3): Pt => projectPx(world, camera, width, height);

    const geometry = new GeometryIndex();
    for (const polyline of this.geometryLocal) {
      geometry.addPolyline(polyline.map(p => project(localToWorld(p, this.plane))));
    }
    // Vertex/center dots are drawn (and draggable) too: a small cross per
    // dot makes a candidate box over one score as sitting on geometry.
    for (const dot of this.dotsLocal) {
      const at = project(localToWorld(dot, this.plane));
      geometry.addSegment(
        { x: at.x - VERTEX_CROSS_PX, y: at.y }, { x: at.x + VERTEX_CROSS_PX, y: at.y },
      );
      geometry.addSegment(
        { x: at.x, y: at.y - VERTEX_CROSS_PX }, { x: at.x, y: at.y + VERTEX_CROSS_PX },
      );
    }
    // Dimension lines count as drawn geometry — a badge parked on one reads
    // as part of the dimension — but each is OWNED by its own label, which
    // discounts it: a value belongs on its line, not pushed off it.
    this.dimensions.forEach((sprite, index) => {
      if (sprite.leader) {
        geometry.addPolyline(sprite.leader.map(p => project(localToWorld(p, this.plane))), index);
      }
    });

    const obstacles: Rect[] = [];
    for (const item of this.fixed) {
      const at = project(item.anchorWorld);
      const dir = unitDir(projection, item.dirLocal, { x: 0, y: -1 });
      const cx = at.x + dir.x * item.radiusPx;
      const cy = at.y + dir.y * item.radiusPx;
      item.placement.visible = true;
      item.placement.dx = cx - at.x;
      item.placement.dy = cy - at.y;
      obstacles.push({ cx, cy, hw: item.halfWidthPx, hh: item.halfHeightPx });
    }

    const badgeItems: BadgeItem[] = this.badges.map(sprite => {
      const alongVec = mapDir(projection, sprite.alongLocal);
      return {
        anchor: project(sprite.anchorWorld),
        groupKey: sprite.groupKey,
        out: unitDir(projection, sprite.outLocal, { x: 0, y: -1 }),
        along: unitDir(projection, sprite.alongLocal, { x: 1, y: 0 }),
        // Sketch units → pixels: this is where zoom enters the layout.
        spanPx: sprite.span * Math.hypot(alongVec.x, alongVec.y),
        hw: sprite.halfWidthPx,
        hh: sprite.halfHeightPx,
        rank: sprite.rank,
        order: sprite.order,
      };
    });

    const dimItems: DimensionItem[] = this.dimensions.map((sprite, index) => {
      const slideVec = mapDir(projection, sprite.slideLocal);
      const slidePx = Math.hypot(slideVec.x, slideVec.y);
      const slide = unitDir(projection, sprite.slideLocal, { x: 1, y: 0 });
      // An aligned label lies ALONG its dimension line, so it rolls to the
      // line's screen angle — flipped to keep the value readable. The hit
      // target shares this box, so the pick rolls with the label; only the
      // declutterer needs the axis-aligned bounds of the result.
      sprite.box.roll = sprite.style === 'aligned' ? rollFor(slide) : 0;
      const rolled = rolledBounds(sprite, sprite.box.roll);
      return {
        anchor: project(sprite.anchorWorld),
        push: unitDir(projection, sprite.pushLocal, { x: 0, y: -1 }),
        slide,
        style: sprite.style,
        // Clamp the reach: a label 300 px down its own dimension line reads
        // as belonging to whatever it landed next to instead.
        slideRangePx: Math.min(sprite.slideRange * slidePx, MAX_SLIDE_PX),
        lineOwner: index,
        hw: rolled.halfWidthPx,
        hh: rolled.halfHeightPx,
        order: sprite.order,
      };
    });

    const result = declutterAnnotations({
      badges: badgeItems,
      dimensions: dimItems,
      obstacles,
      geometry,
      pillSize: count => {
        const texture = getIconTexture(pillLabel(count), '#ffffff');
        return { hw: (BADGE_PX_SIZE * texture.aspect) / 2, hh: BADGE_PX_SIZE / 2 };
      },
    });

    this.badges.forEach((sprite, i) => Object.assign(sprite.placement, result.badges[i]));
    this.dimensions.forEach((sprite, i) => {
      Object.assign(sprite.placement, result.dimensions[i]);
      this.updateLink(sprite, projection);
    });
    this.syncPills(result.pills, projection);
    this.syncRowLinks(result.links, projection);
  }

  /**
   * Stubs from displaced badge rows back to their anchors (the badge
   * counterpart of updateLink). Endpoints are carried back to the plane and
   * written in world coordinates, so they stay glued across pans like the
   * pills do; a zoom step re-solves and rewrites them.
   */
  private syncRowLinks(links: { from: Pt; to: Pt }[], projection: PlaneProjection): void {
    const originPx = projection.originPx;
    const toWorld = (p: Pt): Vector3 => localToWorld(
      screenOffsetToLocal(projection, p.x - originPx.x, p.y - originPx.y), this.plane,
    );
    for (let i = 0; i < links.length; i++) {
      let line = this.rowLinks[i];
      if (!line) {
        line = createLinkLine(this.pillColor);
        this.rowLinks[i] = line;
        this.pillGroup.add(line);
      }
      const from = toWorld(links[i].from);
      const to = toWorld(links[i].to);
      const position = line.geometry.getAttribute('position');
      position.setXYZ(0, from.x, from.y, from.z);
      position.setXYZ(1, to.x, to.y, to.z);
      position.needsUpdate = true;
      line.geometry.computeBoundingSphere();
      line.visible = true;
    }
    for (let i = links.length; i < this.rowLinks.length; i++) {
      this.rowLinks[i].visible = false;
    }
  }

  /**
   * Stub from a pushed-out label back to the nearest point of its dimension
   * line — the drafting answer to "which dimension is that number for?".
   * Drawn in sketch-local space (the leader is), so it is mapped back out of
   * screen pixels through the plane projection.
   */
  private updateLink(sprite: DimensionSprite, projection: PlaneProjection): void {
    const link = sprite.link;
    if (!link) {
      return;
    }
    const leader = sprite.leader;
    const offset = Math.hypot(sprite.placement.dx, sprite.placement.dy);
    if (!leader || !sprite.placement.visible || offset < LABEL_LINK_THRESHOLD_PX) {
      link.visible = false;
      return;
    }
    const local = screenOffsetToLocal(projection, sprite.placement.dx, sprite.placement.dy);
    const labelLocal: Vec2 = [sprite.anchorLocal[0] + local[0], sprite.anchorLocal[1] + local[1]];
    const foot = closestOnSegment(leader[0], leader[1], labelLocal);
    const from = localToWorld(foot, this.plane);
    const to = localToWorld(labelLocal, this.plane);
    const position = link.geometry.getAttribute('position');
    position.setXYZ(0, from.x, from.y, from.z);
    position.setXYZ(1, to.x, to.y, to.z);
    position.needsUpdate = true;
    link.geometry.computeBoundingSphere();
    link.visible = true;
  }

  private syncPills(pills: { at: Pt; count: number }[], projection: PlaneProjection): void {
    const originPx = projection.originPx;
    for (let i = 0; i < pills.length; i++) {
      const pill = this.acquirePill(i);
      const texture = getIconTexture(pillLabel(pills[i].count), '#ffffff');
      pill.material.map = texture.texture;
      pill.material.needsUpdate = true;
      pill.mesh.scale.set(texture.aspect, 1, 1);
      // Pills have no sketch anchor of their own — carry the screen position
      // back to the plane so the shared transform pass can place them.
      const local = screenOffsetToLocal(
        projection, pills[i].at.x - originPx.x, pills[i].at.y - originPx.y,
      );
      pill.group.position.copy(localToWorld(local, this.plane));
      pill.group.visible = true;
      pill.group.userData.anchorWorld = pill.group.position.clone();
    }
    for (let i = pills.length; i < this.pills.length; i++) {
      this.pills[i].group.visible = false;
    }
  }

  private acquirePill(index: number): { group: Group; mesh: Mesh; material: MeshBasicMaterial } {
    const existing = this.pills[index];
    if (existing) {
      return existing;
    }
    const material = new MeshBasicMaterial({
      transparent: true,
      depthTest: false,
      side: DoubleSide,
      color: this.pillColor,
      // Dimmer than a real badge: it is a count, not a constraint.
      opacity: 0.65,
    });
    const mesh = new Mesh(new PlaneGeometry(GLYPH_PLANE_SIZE, GLYPH_PLANE_SIZE), material);
    mesh.renderOrder = GLYPH_RENDER_ORDER;
    const group = new Group();
    group.renderOrder = GLYPH_RENDER_ORDER;
    group.userData.isConstraintIcon = true;
    group.add(mesh);
    this.pillGroup.add(group);
    const pill = { group, mesh, material };
    this.pills[index] = pill;
    return pill;
  }

  /** Push every sprite to its placement: camera-facing, screen-constant, and
   * offset from its anchor in screen pixels. */
  private applyTransforms(renderer: WebGLRenderer, camera: Camera): void {
    camera.matrixWorld.extractBasis(_camRight, _camUp, _camFwd);
    const place = (sprite: LayoutSprite, roll = 0): void => {
      if (!sprite.placement.visible) {
        sprite.group.visible = false;
        return;
      }
      const anchor = sprite.anchorWorld;
      const worldPerPx = pixelsToWorld(renderer, camera, anchor, 1);
      sprite.group.visible = true;
      sprite.group.position.copy(anchor)
        .addScaledVector(_camRight, sprite.placement.dx * worldPerPx)
        .addScaledVector(_camUp, -sprite.placement.dy * worldPerPx);
      sprite.group.quaternion.copy(_camQuat);
      if (roll !== 0) {
        // Spin in the view plane (the sprite's own +Z faces the camera), so
        // an aligned label reads along its line at any camera angle.
        sprite.group.quaternion.multiply(_roll.setFromAxisAngle(_viewAxis, roll));
      }
      sprite.group.scale.setScalar(
        pixelScale(renderer, camera, anchor, sprite.pxSize, GLYPH_PLANE_SIZE),
      );
      sprite.group.updateMatrixWorld(true);
    };
    for (const sprite of this.badges) {
      place(sprite);
    }
    for (const sprite of this.dimensions) {
      place(sprite, sprite.box.roll);
    }
    for (const pill of this.pills) {
      if (!pill.group.visible) {
        continue;
      }
      const anchor = pill.group.userData.anchorWorld as Vector3;
      pill.group.position.copy(anchor);
      pill.group.quaternion.copy(_camQuat);
      pill.group.scale.setScalar(
        pixelScale(renderer, camera, anchor, BADGE_PX_SIZE, GLYPH_PLANE_SIZE),
      );
      pill.group.updateMatrixWorld(true);
    }
  }
}

export function pillLabel(count: number): string {
  return `+${count}`;
}

/** A camera-facing sprite the layout drives — no self-positioning hook. */
export function createGlyphSprite(
  map: MeshBasicMaterial['map'],
  aspect: number,
  color: Color,
): { group: Group; material: MeshBasicMaterial } {
  const material = new MeshBasicMaterial({
    map,
    transparent: true,
    depthTest: false,
    side: DoubleSide,
    color,
  });
  const mesh = new Mesh(
    new PlaneGeometry(GLYPH_PLANE_SIZE * aspect, GLYPH_PLANE_SIZE),
    material,
  );
  mesh.renderOrder = GLYPH_RENDER_ORDER;
  const group = new Group();
  group.renderOrder = GLYPH_RENDER_ORDER;
  group.userData.isConstraintIcon = true;
  // Placed off-screen until the first layout pass runs, so a glyph never
  // flashes at the sketch origin on the frame it is created.
  group.visible = false;
  group.add(mesh);
  return { group, material };
}

/** Two-vertex line the layout rewrites in place (the label link stub). */
export function createLinkLine(color: Color): Line {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  const material = new LineBasicMaterial({
    color, transparent: true, opacity: LINK_OPACITY, depthTest: false,
  });
  const line = new Line(geometry, material);
  line.renderOrder = GLYPH_RENDER_ORDER - 1;
  line.frustumCulled = false;
  line.visible = false;
  line.userData.isConstraintIcon = true;
  return line;
}

/** Invert the plane→screen map for a pixel delta. Degenerate only when the
 * view is edge-on to the sketch, where nothing is readable anyway. */
function screenOffsetToLocal(p: PlaneProjection, dx: number, dy: number): Vec2 {
  const det = p.ax * p.by - p.bx * p.ay;
  if (Math.abs(det) < 1e-12) {
    return [0, 0];
  }
  return [(dx * p.by - dy * p.bx) / det, (dy * p.ax - dx * p.ay) / det];
}

function closestOnSegment(a: Vec2, b: Vec2, p: Vec2): Vec2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) {
    return a;
  }
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return [a[0] + dx * t, a[1] + dy * t];
}
