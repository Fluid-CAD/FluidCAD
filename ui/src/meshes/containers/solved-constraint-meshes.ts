// Meshes for the solved-sketch constraint glyphs (sketch-rewrite P3, P5.5).
//
// Consumes the pure glyph descriptors from ui/src/sketch-solver-client and
// builds the Three groups: boxed badges and dimension text screen-constant
// like the legacy constraint icons, dimension leaders world-scale. Textures
// render white and are tinted through material.color, so diagnostic states
// (redundant amber, conflict red) and hover highlights recolor without new
// textures.
//
// Badges and dimension labels do NOT position themselves any more: this pass
// only builds them and hands the pieces to a SolvedGlyphLayout, which decides
// per zoom step where each one sits and which ones collapse behind a `+N`
// pill (see solved-glyph-layout.ts). Each glyph still yields a screen-space
// hit target, and that target shares the layout's Placement object by
// reference — so what is drawn stays exactly what is pickable however the
// camera moves.

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  Vector3,
} from 'three';
import type { PlaneData, SourceLocation, Vec3Data } from '../../types';
import type { ConstraintGlyph, GlyphColorRole, SolvedSketchModel } from '../../sketch-solver-client';
import type { Placement } from '../../sketch-solver-client/declutter';
import { localToWorld } from '../../interactive/sketch-plane-utils';
import { applyConstantPixelSize, pixelScale, pixelsToWorld } from '../screen-scale';
import { themeColors } from '../../scene/theme-colors';
import { createTextTexture, getIconTexture, getTextTexture, IconTexture } from './badge-textures';
import { buildDimensionArrows } from './dimension-arrows';
import {
  ANGLE_LABEL_PX_SIZE,
  BADGE_PX_SIZE,
  GLYPH_PLANE_SIZE,
  GLYPH_RENDER_ORDER,
  LABEL_PX_SIZE,
  SolvedGlyphLayout,
  createGlyphSprite,
  createLinkLine,
} from './solved-glyph-layout';
import type { BadgeSprite, DimensionSprite, FixedAnnotation } from './solved-glyph-layout';

const ICON_PLANE_SIZE = GLYPH_PLANE_SIZE;
const ICON_RENDER_ORDER = GLYPH_RENDER_ORDER;
const TEXT_OFFSET_PX = 14;
const TEXT_PX_SIZE = LABEL_PX_SIZE;
const DOT_PLANE_RADIUS = 2;
const DOT_PX_RADIUS = 8;
const LEADER_OPACITY = 0.45;
const ANGLE_ARC_RADIUS = 5;
const ANGLE_ARC_PX_RADIUS = 26;
const ANGLE_TEXT_PX_SIZE = ANGLE_LABEL_PX_SIZE;
const ANGLE_ARC_SEGMENTS = 32;

/** Screen-space pick target for one glyph — what the hover handler tests. */
export type BadgeHitTarget = {
  objId?: string;
  sourceLocation?: SourceLocation;
  refEntityIds: number[];
  /** World position of the glyph's sketch anchor. */
  anchorWorld: Vector3;
  /** Live screen-pixel offset from that anchor. Owned by the layout pass —
   * a hidden glyph's placement reports `visible: false` and must not pick. */
  placement: Placement;
  halfWidthPx: number;
  halfHeightPx: number;
  /** Materials to recolor while hovered. */
  materials: (MeshBasicMaterial | LineBasicMaterial)[];
  baseColor: Color;
  /** Drawn ON the geometry (coincident dots sit on the shared vertex):
   * clicks still pick the statement, but the glyph must not veto vertex
   * drags the way offset badges do (P4). */
  onGeometry?: boolean;
};

export type SolvedConstraintVisuals = {
  groups: Group[];
  hitTargets: BadgeHitTarget[];
  /** Drives the screen-space placement every frame; null when the sketch has
   * no placeable annotation. */
  layout: SolvedGlyphLayout | null;
};

function roleColor(role: GlyphColorRole): Color {
  switch (role) {
    case 'conflict':
      return themeColors.constraintConflictColor;
    case 'redundant':
      return themeColors.constraintRedundantColor;
    default:
      return themeColors.constraintColor;
  }
}

function dirToWorld(dir: [number, number], plane: PlaneData): Vector3 {
  return new Vector3(
    plane.xDirection.x * dir[0] + plane.yDirection.x * dir[1],
    plane.xDirection.y * dir[0] + plane.yDirection.y * dir[1],
    plane.xDirection.z * dir[0] + plane.yDirection.z * dir[1],
  ).normalize();
}

function orientToPlane(group: Group, position: Vector3, plane: PlaneData, normal: Vec3Data): void {
  group.position.copy(position);
  group.up.set(plane.yDirection.x, plane.yDirection.y, plane.yDirection.z);
  group.lookAt(new Vector3(position.x + normal.x, position.y + normal.y, position.z + normal.z));
}

/** Screen-constant textured plane (badge box or bare text) offset from its
 * anchor along a world direction by a pixel amount. Self-positioning — used
 * by the toolbar's placement previews, which sit outside the layout pass. */
function createOffsetSprite(
  texture: IconTexture,
  color: Color,
  position: Vector3,
  offsetDirWorld: Vector3,
  offsetPx: number,
  pxSize: number,
  plane: PlaneData,
  normal: Vec3Data,
): { group: Group; material: MeshBasicMaterial } {
  const geometry = new PlaneGeometry(ICON_PLANE_SIZE * texture.aspect, ICON_PLANE_SIZE);
  const material = new MeshBasicMaterial({
    map: texture.texture,
    transparent: true,
    depthTest: false,
    side: DoubleSide,
    color,
  });
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = ICON_RENDER_ORDER;

  const group = new Group();
  group.renderOrder = ICON_RENDER_ORDER;
  group.userData.isConstraintIcon = true;
  orientToPlane(group, position, plane, normal);
  group.add(mesh);

  mesh.onBeforeRender = (renderer, _scene, camera) => {
    const offsetWorld = pixelsToWorld(renderer, camera, position, offsetPx);
    group.position.set(
      position.x + offsetDirWorld.x * offsetWorld,
      position.y + offsetDirWorld.y * offsetWorld,
      position.z + offsetDirWorld.z * offsetWorld,
    );
    group.scale.setScalar(pixelScale(renderer, camera, position, pxSize, ICON_PLANE_SIZE));
    group.updateMatrixWorld(true);
  };

  return { group, material };
}

/**
 * Dashed helper leaders from each segment's nearest endpoint to the virtual
 * intersection an angle dimension anchors on (Fusion/FreeCAD extension
 * lines). World-scale — deliberately OUTSIDE the screen-constant arc group.
 * Dash length is proportional to each extension so density reads the same
 * whatever the sketch's size. Null when there is nothing to draw.
 */
export function buildAngleExtensions(
  extensions: [[number, number], [number, number]][],
  plane: PlaneData,
  color: Color,
  opacity = LEADER_OPACITY,
): Group | null {
  if (extensions.length === 0) {
    return null;
  }
  const group = new Group();
  group.renderOrder = ICON_RENDER_ORDER - 1;
  group.userData.isConstraintIcon = true;
  for (const [fromLocal, toLocal] of extensions) {
    const from = localToWorld(fromLocal, plane);
    const to = localToWorld(toLocal, plane);
    const len = from.distanceTo(to);
    if (len < 1e-9) {
      continue;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      from.x, from.y, from.z,
      to.x, to.y, to.z,
    ], 3));
    // Quantize the pattern so the line starts AND ends on a full dash —
    // len = (n+1)·dash + n·gap with gap = 0.7·dash, n = 8 gaps. A
    // free-running pattern can end mid-gap, visibly detaching the leader
    // from the arc it must touch (and from the solid segment behind it).
    const dash = len / (1 + 1.7 * 8);
    const material = new LineDashedMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
      dashSize: dash,
      gapSize: 0.7 * dash,
    });
    const line = new Line(geometry, material);
    // Dash rendering is inert without per-vertex line distances.
    line.computeLineDistances();
    line.renderOrder = ICON_RENDER_ORDER - 1;
    group.add(line);
  }
  return group.children.length > 0 ? group : null;
}

export type AngleArcVisual = {
  group: Group;
  /** World position of the arc center (the lines' intersection). */
  position: Vector3;
  midAngle: number;
  /** Pixel radius of the label anchor from the arc center. */
  textPxRadius: number;
  textAspect: number;
  materials: (MeshBasicMaterial | LineBasicMaterial)[];
  /** Uncached label texture (opacity previews) — dispose with the group. */
  ownedTexture: IconTexture['texture'] | null;
};

/**
 * Screen-constant angle dimension arc + readout, shared by the committed
 * glyph and the toolbar's placement/pending previews. `opacity < 1` marks a
 * preview: its label texture is created uncached (live readouts change
 * every frame) and returned for disposal.
 */
export function buildAngleArc(
  at: [number, number],
  startAngle: number,
  sweep: number,
  label: string | null,
  plane: PlaneData,
  normal: Vec3Data,
  color: Color,
  opacity = 0.9,
  tails: number[] = [],
): AngleArcVisual {
  const position = localToWorld(at, plane);
  const group = new Group();
  group.renderOrder = ICON_RENDER_ORDER;
  group.userData.isConstraintIcon = true;
  orientToPlane(group, position, plane, normal);

  const arcPoints: number[] = [];
  for (let i = 0; i <= ANGLE_ARC_SEGMENTS; i++) {
    const a = startAngle + sweep * (i / ANGLE_ARC_SEGMENTS);
    arcPoints.push(Math.cos(a) * ANGLE_ARC_RADIUS, Math.sin(a) * ANGLE_ARC_RADIUS, 0);
  }
  const arcGeometry = new BufferGeometry();
  arcGeometry.setAttribute('position', new Float32BufferAttribute(arcPoints, 3));
  const arcMaterial = new LineBasicMaterial({
    color, transparent: true, opacity, depthTest: false,
  });
  const arc = new Line(arcGeometry, arcMaterial);
  arc.renderOrder = ICON_RENDER_ORDER;
  group.add(arc);

  // Dashed tail stubs from the center to just past the rim along sector
  // rays no segment covers — with the world-scale extension leader arriving
  // on the opposite ray, the pair reads as one straight dashed line through
  // the intersection that TOUCHES the arc's end. Group-local units, so the
  // dashes stay screen-constant like the arc.
  const tailRadius = ANGLE_ARC_RADIUS * 1.25;
  for (const angle of tails) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0,
      Math.cos(angle) * tailRadius, Math.sin(angle) * tailRadius, 0,
    ], 3));
    // 3 gaps + 4 dashes, dash-aligned at both ends (see buildAngleExtensions).
    const dash = tailRadius / (1 + 1.7 * 3);
    const material = new LineDashedMaterial({
      color, transparent: true, opacity: Math.min(opacity, LEADER_OPACITY),
      depthTest: false, dashSize: dash, gapSize: 0.7 * dash,
    });
    const tail = new Line(geometry, material);
    tail.computeLineDistances();
    tail.renderOrder = ICON_RENDER_ORDER - 1;
    group.add(tail);
  }

  const materials: (MeshBasicMaterial | LineBasicMaterial)[] = [arcMaterial];
  const midAngle = startAngle + sweep / 2;
  const textSize = ANGLE_ARC_RADIUS * (ANGLE_TEXT_PX_SIZE / ANGLE_ARC_PX_RADIUS);
  const textRadius = ANGLE_ARC_RADIUS + textSize;
  let textAspect = 1;
  let ownedTexture: IconTexture['texture'] | null = null;
  let sizeAnchor: Mesh | Line = arc;
  if (label !== null) {
    const cached = opacity >= 0.9;
    const texture = cached ? getTextTexture(label, '#ffffff') : createTextTexture(label, '#ffffff');
    textAspect = texture.aspect;
    if (!cached) {
      ownedTexture = texture.texture;
    }
    const textMaterial = new MeshBasicMaterial({
      map: texture.texture, transparent: true, opacity, depthTest: false, side: DoubleSide, color,
    });
    const textMesh = new Mesh(
      new PlaneGeometry(textSize * texture.aspect, textSize),
      textMaterial,
    );
    textMesh.renderOrder = ICON_RENDER_ORDER;
    textMesh.position.set(Math.cos(midAngle) * textRadius, Math.sin(midAngle) * textRadius, 0);
    group.add(textMesh);
    materials.push(textMaterial);
    sizeAnchor = textMesh;
  }

  applyConstantPixelSize(sizeAnchor, group, position, ANGLE_ARC_PX_RADIUS, ANGLE_ARC_RADIUS);

  return {
    group,
    position,
    midAngle,
    textPxRadius: (textRadius / ANGLE_ARC_RADIUS) * ANGLE_ARC_PX_RADIUS,
    textAspect,
    materials,
    ownedTexture,
  };
}

export type DimensionReadoutVisual = {
  group: Group;
  /** Uncached label texture (live readouts change per region) — dispose
   * with the group. */
  ownedTexture: IconTexture['texture'];
};

/**
 * Screen-constant live value readout for the toolbar's distance placement
 * preview — bare dimension text offset from its sketch anchor like the
 * committed glyph's label, with an uncached texture (the label changes as
 * the cursor crosses form regions).
 */
export function buildDimensionReadout(
  at: [number, number],
  label: string,
  offsetDir: [number, number],
  plane: PlaneData,
  normal: Vec3Data,
  color: Color,
  opacity: number,
): DimensionReadoutVisual {
  const texture = createTextTexture(label, '#ffffff');
  const position = localToWorld(at, plane);
  const { group, material } = createOffsetSprite(
    texture, color, position, dirToWorld(offsetDir, plane),
    TEXT_OFFSET_PX, TEXT_PX_SIZE, plane, normal,
  );
  material.opacity = opacity;
  return { group, ownedTexture: texture.texture };
}

/** Anchor identity: badges resolving to the same sketch point share a row. */
function anchorKey(at: [number, number]): string {
  return `${Math.round(at[0] * 1e3)},${Math.round(at[1] * 1e3)}`;
}

export function buildSolvedConstraintMeshes(
  model: SolvedSketchModel,
  glyphs: ConstraintGlyph[],
): SolvedConstraintVisuals {
  const plane = model.plane;
  const normal = plane.normal;
  const groups: Group[] = [];
  const hitTargets: BadgeHitTarget[] = [];
  const badgeSprites: BadgeSprite[] = [];
  const dimensionSprites: DimensionSprite[] = [];
  const fixedAnnotations: FixedAnnotation[] = [];
  const white = '#ffffff';

  glyphs.forEach((glyph, order) => {
    const color = roleColor(glyph.color);

    switch (glyph.type) {
      case 'badge':
      case 'text': {
        const isBadge = glyph.type === 'badge';
        const texture = isBadge
          ? getIconTexture(glyph.label, white)
          : getTextTexture(glyph.label, white);
        const position = localToWorld(glyph.at, plane);
        const pxSize = isBadge ? BADGE_PX_SIZE : TEXT_PX_SIZE;
        const { group, material } = createGlyphSprite(texture.texture, texture.aspect, color);
        const placement: Placement = { visible: false, dx: 0, dy: 0 };
        groups.push(group);

        const hit: BadgeHitTarget = {
          objId: glyph.objId,
          sourceLocation: glyph.sourceLocation,
          refEntityIds: glyph.refEntityIds,
          anchorWorld: position,
          placement,
          halfWidthPx: (pxSize * texture.aspect) / 2,
          halfHeightPx: pxSize / 2,
          materials: [material],
          baseColor: color,
        };
        hitTargets.push(hit);

        const common = {
          group,
          anchorLocal: glyph.at,
          anchorWorld: position,
          placement,
          pxSize,
          halfWidthPx: hit.halfWidthPx,
          halfHeightPx: hit.halfHeightPx,
        };
        if (isBadge) {
          badgeSprites.push({
            ...common,
            outLocal: glyph.offsetDir,
            alongLocal: glyph.alongDir,
            span: glyph.span,
            groupKey: anchorKey(glyph.at),
            rank: glyph.rank,
            order,
          });
        } else {
          // An `aligned` label (a diameter chord, a radius) lies centered ON its
          // line already — a link stub back to it would only add a line.
          const link = glyph.leader && glyph.style !== 'aligned' ? createLinkLine(color) : null;
          if (link) {
            groups.push(wrapLink(link));
          }
          dimensionSprites.push({
            ...common,
            pushLocal: glyph.offsetDir,
            slideLocal: glyph.alongDir,
            style: glyph.style,
            slideRange: glyph.slideRange,
            leader: glyph.leader ?? null,
            link,
            order,
            // A rolled label's screen bounds move with the camera: the hit
            // target hands its own box to the layout so the pick stays on
            // what is drawn (the placement's by-reference rule).
            box: hit,
            roll: 0,
          });
        }
        break;
      }

      case 'dot': {
        const position = localToWorld(glyph.at, plane);
        const geometry = new RingGeometry(DOT_PLANE_RADIUS * 0.55, DOT_PLANE_RADIUS, 24);
        const material = new MeshBasicMaterial({
          color,
          side: DoubleSide,
          depthTest: false,
          transparent: true,
          opacity: 0.9,
        });
        const dot = new Mesh(geometry, material);
        dot.renderOrder = ICON_RENDER_ORDER;
        const group = new Group();
        group.renderOrder = ICON_RENDER_ORDER;
        group.userData.isConstraintIcon = true;
        orientToPlane(group, position, plane, normal);
        group.add(dot);
        applyConstantPixelSize(dot, group, position, DOT_PX_RADIUS, DOT_PLANE_RADIUS);
        groups.push(group);
        hitTargets.push({
          objId: glyph.objId,
          sourceLocation: glyph.sourceLocation,
          refEntityIds: glyph.refEntityIds,
          anchorWorld: position,
          // Rings sit ON their vertex — no offset, and never decluttered.
          placement: { visible: true, dx: 0, dy: 0 },
          halfWidthPx: DOT_PX_RADIUS + 2,
          halfHeightPx: DOT_PX_RADIUS + 2,
          materials: [material],
          baseColor: color,
          onGeometry: true,
        });
        break;
      }

      case 'leader': {
        const from = localToWorld(glyph.from, plane);
        const to = localToWorld(glyph.to, plane);
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute([
          from.x, from.y, from.z,
          to.x, to.y, to.z,
        ], 3));
        const material = new LineBasicMaterial({
          color,
          transparent: true,
          opacity: LEADER_OPACITY,
          depthTest: false,
        });
        const line = new Line(geometry, material);
        line.renderOrder = ICON_RENDER_ORDER - 1;
        const group = new Group();
        group.renderOrder = ICON_RENDER_ORDER - 1;
        group.userData.isConstraintIcon = true;
        group.add(line);
        if (glyph.arrows) {
          const arrows = buildDimensionArrows(
            [glyph.from, glyph.to], plane, normal, color, LEADER_OPACITY,
            ICON_RENDER_ORDER - 1, glyph.arrows,
          );
          if (arrows) {
            group.add(arrows);
          }
        }
        groups.push(group);
        // Dashed witness extensions to anchors the leader doesn't reach
        // (axis-locked distances) — same styling as the angle extensions.
        const leaderExt = buildAngleExtensions(glyph.extensions ?? [], plane, color);
        if (leaderExt) {
          groups.push(leaderExt);
        }
        // Leaders are context, not pick targets — the paired text glyph is.
        break;
      }

      case 'angle-arc': {
        const visual = buildAngleArc(
          glyph.at, glyph.startAngle, glyph.sweep, glyph.label, plane, normal, color,
          undefined, glyph.tails,
        );
        groups.push(visual.group);
        // Dashed extension leaders to a virtual intersection — context,
        // not pick targets (like distance leaders).
        const ext = buildAngleExtensions(glyph.extensions, plane, color);
        if (ext) {
          groups.push(ext);
        }
        // The readout rides its arc (a geometric construction, not a free
        // label), so the layout only RESERVES its box — nothing else may
        // land on it — and keeps the pick offset in step.
        const placement: Placement = { visible: true, dx: 0, dy: 0 };
        fixedAnnotations.push({
          anchorWorld: visual.position,
          dirLocal: [Math.cos(visual.midAngle), Math.sin(visual.midAngle)],
          radiusPx: visual.textPxRadius,
          halfWidthPx: (ANGLE_TEXT_PX_SIZE * visual.textAspect) / 2,
          halfHeightPx: ANGLE_TEXT_PX_SIZE / 2,
          placement,
        });
        hitTargets.push({
          objId: glyph.objId,
          sourceLocation: glyph.sourceLocation,
          refEntityIds: glyph.refEntityIds,
          anchorWorld: visual.position,
          placement,
          halfWidthPx: (ANGLE_TEXT_PX_SIZE * visual.textAspect) / 2,
          halfHeightPx: ANGLE_TEXT_PX_SIZE / 2,
          materials: visual.materials,
          baseColor: color,
        });
        break;
      }
    }
  });

  const placeable = badgeSprites.length + dimensionSprites.length + fixedAnnotations.length;
  let layout: SolvedGlyphLayout | null = null;
  if (placeable > 0) {
    layout = new SolvedGlyphLayout(
      plane, badgeSprites, dimensionSprites, fixedAnnotations, model,
      themeColors.constraintColor,
    );
    groups.push(layout.pillGroup);
  }

  return { groups, hitTargets, layout };
}

/** Link stubs are plain Lines; the disposal walk expects Groups. */
function wrapLink(link: Line): Group {
  const group = new Group();
  group.renderOrder = ICON_RENDER_ORDER - 1;
  group.userData.isConstraintIcon = true;
  group.add(link);
  return group;
}
