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
import type {
  ArcStretch, ConstraintGlyph, GlyphColorRole, SolvedSketchModel,
} from '../../sketch-solver-client';
import { angleLabelPlacement } from '../../sketch-solver-client';
import type { Placement } from '../../sketch-solver-client/declutter';
import { localToWorld } from '../../interactive/sketch-plane-utils';
import { applyConstantPixelSize } from '../screen-scale';
import { themeColors } from '../../scene/theme-colors';
import { PLACED_ANNOTATION_FLAG } from '../../scene/scene-geometry-bounds';
import { getIconTexture, getTextTexture } from './badge-textures';
import { buildDimensionArrows } from './dimension-arrows';
import {
  ANGLE_LABEL_PX_SIZE,
  BADGE_PX_SIZE,
  GLYPH_RENDER_ORDER,
  LABEL_PX_SIZE,
  SolvedGlyphLayout,
  createGlyphSprite,
  createLinkLine,
} from './solved-glyph-layout';
import type { BadgeSprite, BoxPx, DimensionSprite, FixedAnnotation } from './solved-glyph-layout';

const ICON_RENDER_ORDER = GLYPH_RENDER_ORDER;
const TEXT_PX_SIZE = LABEL_PX_SIZE;
const DOT_PLANE_RADIUS = 2;
const DOT_PX_RADIUS = 8;
const LEADER_OPACITY = 0.45;
const ANGLE_ARC_RADIUS = 5;
/** Base pixel radius of the angle dimension arc. */
const ANGLE_ARC_PX_RADIUS = 26;
const ANGLE_TEXT_PX_SIZE = ANGLE_LABEL_PX_SIZE;
const ANGLE_ARC_SEGMENTS = 32;
/** A placed angle's arc is world-scale — it can fill the screen — so it is
 * tessellated by angle instead of with a fixed count: this many segments per
 * full turn, never fewer than the floor. */
const WORLD_ARC_SEGMENTS_PER_TURN = 144;
const WORLD_ARC_MIN_SEGMENTS = 12;
const ANGLE_ARC_OPACITY = 0.9;

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
  /** In-plane roll of that box on screen, radians CCW — an `aligned`
   * dimension label lies ALONG its line, so its drawn rectangle is not
   * screen-axis-aligned. Owned by the layout pass (by reference, like
   * `placement`); 0 for every other glyph. */
  roll: number;
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

function orientToPlane(group: Group, position: Vector3, plane: PlaneData, normal: Vec3Data): void {
  group.position.copy(position);
  group.up.set(plane.yDirection.x, plane.yDirection.y, plane.yDirection.z);
  group.lookAt(new Vector3(position.x + normal.x, position.y + normal.y, position.z + normal.z));
}

/**
 * Dashed helper leaders from each segment's nearest endpoint to the virtual
 * intersection an angle dimension anchors on (Fusion/FreeCAD extension
 * lines). World-scale — deliberately OUTSIDE the screen-constant arc group.
 * Dash length is proportional to each extension so density reads the same
 * whatever the sketch's size. Null when there is nothing to draw.
 */
function buildAngleExtensions(
  extensions: [[number, number], [number, number]][],
  plane: PlaneData,
  color: Color,
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
      opacity: LEADER_OPACITY,
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

/** Points along a circular stretch, sketch-local → world. */
function arcWorldPoints(arc: ArcStretch, plane: PlaneData): number[] {
  const segments = Math.max(
    WORLD_ARC_MIN_SEGMENTS,
    Math.ceil((Math.abs(arc.sweep) / (2 * Math.PI)) * WORLD_ARC_SEGMENTS_PER_TURN),
  );
  const points: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = arc.a0 + arc.sweep * (i / segments);
    const world = localToWorld(
      [arc.center[0] + Math.cos(a) * arc.radius, arc.center[1] + Math.sin(a) * arc.radius],
      plane,
    );
    points.push(world.x, world.y, world.z);
  }
  return points;
}

/**
 * Dashed continuations of an arc — a radius leader landing off the drawn
 * arc, a placed angle's value sitting outside its sector. World-scale and
 * styled like the straight witness leaders (buildAngleExtensions): the dash
 * is proportional to each stretch, quantized so it starts and ends on a full
 * dash. Null when there is nothing to draw.
 */
function buildWitnessArcs(
  arcs: ArcStretch[],
  plane: PlaneData,
  color: Color,
): Group | null {
  const group = new Group();
  group.renderOrder = ICON_RENDER_ORDER - 1;
  group.userData.isConstraintIcon = true;
  for (const arc of arcs) {
    const length = Math.abs(arc.sweep) * arc.radius;
    if (!(length > 1e-9)) {
      continue;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(arcWorldPoints(arc, plane), 3));
    const dash = length / (1 + 1.7 * 8);
    const material = new LineDashedMaterial({
      color, transparent: true, opacity: LEADER_OPACITY, depthTest: false, dashSize: dash, gapSize: 0.7 * dash,
    });
    const line = new Line(geometry, material);
    line.computeLineDistances();
    line.renderOrder = ICON_RENDER_ORDER - 1;
    group.add(line);
  }
  return group.children.length > 0 ? group : null;
}

/**
 * The arc of a PLACED angle dimension: drawn at the sketch-unit radius the
 * statement's `.labelAt()` put it at, so — unlike the screen-constant
 * default (buildAngleArc) — it zooms with the geometry like a distance
 * leader does. Its value is a separate placed label riding it.
 */
function buildPlacedAngleArc(
  arc: ArcStretch,
  plane: PlaneData,
  color: Color,
): Group {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(arcWorldPoints(arc, plane), 3));
  const material = new LineBasicMaterial({
    color, transparent: true, opacity: ANGLE_ARC_OPACITY, depthTest: false,
  });
  const line = new Line(geometry, material);
  line.renderOrder = ICON_RENDER_ORDER;
  const group = new Group();
  group.renderOrder = ICON_RENDER_ORDER;
  group.userData.isConstraintIcon = true;
  group.add(line);
  return group;
}

export type AngleArcVisual = {
  group: Group;
  /** World position of the arc center (the lines' intersection). */
  position: Vector3;
  /** Direction (sketch-local radians) from the center to the readout —
   * the bisector for a comfortable angle, pushed off it for a thin one
   * (see angleLabelPlacement). */
  labelAngle: number;
  /** Pixel radius of the label anchor from the arc center. */
  textPxRadius: number;
  textAspect: number;
  materials: (MeshBasicMaterial | LineBasicMaterial)[];
};

/**
 * Screen-constant angle dimension arc + readout: an angle the automatic
 * layout places (a placed one draws its arc world-scale — buildPlacedAngleArc).
 */
function buildAngleArc(
  at: [number, number],
  startAngle: number,
  sweep: number,
  label: string,
  plane: PlaneData,
  normal: Vec3Data,
  color: Color,
  tails: number[],
): AngleArcVisual {
  const position = localToWorld(at, plane);
  const group = new Group();
  group.renderOrder = ICON_RENDER_ORDER;
  group.userData.isConstraintIcon = true;
  orientToPlane(group, position, plane, normal);

  // Where the readout sits decides where the arc is drawn: the label rides
  // one text-height past its arc (drafting reads the value AT the arc), so
  // when a thin wedge pushes the label out along the bisector — until its
  // box clears both rays, or outside the wedge entirely when no radius ever
  // would — the arc follows it out instead of staying a sliver at the
  // vertex, swamped by the vertex dots.
  const textSize = ANGLE_ARC_RADIUS * (ANGLE_TEXT_PX_SIZE / ANGLE_ARC_PX_RADIUS);
  const texture = getTextTexture(label, '#ffffff');
  const placed = angleLabelPlacement(
    startAngle, sweep,
    (ANGLE_TEXT_PX_SIZE * texture.aspect) / 2, ANGLE_TEXT_PX_SIZE / 2,
    ANGLE_ARC_PX_RADIUS + ANGLE_TEXT_PX_SIZE, ANGLE_ARC_PX_RADIUS,
  );
  const labelAngle = placed.angle;
  const textPxRadius = placed.radiusPx;
  const arcRadius = ANGLE_ARC_RADIUS * (placed.arcRadiusPx / ANGLE_ARC_PX_RADIUS);

  const arcPoints: number[] = [];
  for (let i = 0; i <= ANGLE_ARC_SEGMENTS; i++) {
    const a = startAngle + sweep * (i / ANGLE_ARC_SEGMENTS);
    arcPoints.push(Math.cos(a) * arcRadius, Math.sin(a) * arcRadius, 0);
  }
  const arcGeometry = new BufferGeometry();
  arcGeometry.setAttribute('position', new Float32BufferAttribute(arcPoints, 3));
  const arcMaterial = new LineBasicMaterial({
    color, transparent: true, opacity: ANGLE_ARC_OPACITY, depthTest: false,
  });
  const arc = new Line(arcGeometry, arcMaterial);
  arc.renderOrder = ICON_RENDER_ORDER;
  group.add(arc);

  // Dashed tail stubs from the center to just past the rim along sector
  // rays no segment covers — with the world-scale extension leader arriving
  // on the opposite ray, the pair reads as one straight dashed line through
  // the intersection that TOUCHES the arc's end. Group-local units, so the
  // dashes stay screen-constant like the arc.
  const tailRadius = arcRadius * 1.25;
  for (const angle of tails) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0,
      Math.cos(angle) * tailRadius, Math.sin(angle) * tailRadius, 0,
    ], 3));
    // 3 gaps + 4 dashes, dash-aligned at both ends (see buildAngleExtensions).
    const dash = tailRadius / (1 + 1.7 * 3);
    const material = new LineDashedMaterial({
      color, transparent: true, opacity: LEADER_OPACITY,
      depthTest: false, dashSize: dash, gapSize: 0.7 * dash,
    });
    const tail = new Line(geometry, material);
    tail.computeLineDistances();
    tail.renderOrder = ICON_RENDER_ORDER - 1;
    group.add(tail);
  }

  const textMaterial = new MeshBasicMaterial({
    map: texture.texture, transparent: true, opacity: ANGLE_ARC_OPACITY, depthTest: false,
    side: DoubleSide, color,
  });
  const textMesh = new Mesh(
    new PlaneGeometry(textSize * texture.aspect, textSize),
    textMaterial,
  );
  textMesh.renderOrder = ICON_RENDER_ORDER;
  const textRadius = ANGLE_ARC_RADIUS * (textPxRadius / ANGLE_ARC_PX_RADIUS);
  textMesh.position.set(Math.cos(labelAngle) * textRadius, Math.sin(labelAngle) * textRadius, 0);
  group.add(textMesh);

  applyConstantPixelSize(textMesh, group, position, ANGLE_ARC_PX_RADIUS, ANGLE_ARC_RADIUS);

  return {
    group,
    position,
    labelAngle,
    textPxRadius,
    textAspect: texture.aspect,
    materials: [arcMaterial, textMaterial],
  };
}

/**
 * The box a dimension's value is drawn as, px — the text sprite's own size
 * (buildSolvedConstraintMeshes). Whoever places a value before its meshes
 * exist (a dimension following the cursor as it is drawn) measures with this.
 */
export function dimensionLabelBox(label: string): BoxPx {
  const texture = getTextTexture(label, '#ffffff');
  return { halfWidthPx: (TEXT_PX_SIZE * texture.aspect) / 2, halfHeightPx: TEXT_PX_SIZE / 2 };
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

  /** Add a glyph's group; a placed dimension's stays out of the view's
   * framing (it can be parked any distance from what it measures). */
  const addGroup = (group: Group, placed: boolean): void => {
    if (placed) {
      group.userData[PLACED_ANNOTATION_FLAG] = true;
    }
    groups.push(group);
  };

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
        addGroup(group, glyph.type === 'text' && glyph.placed === true);

        const hit: BadgeHitTarget = {
          objId: glyph.objId,
          sourceLocation: glyph.sourceLocation,
          refEntityIds: glyph.refEntityIds,
          anchorWorld: position,
          placement,
          halfWidthPx: (pxSize * texture.aspect) / 2,
          halfHeightPx: pxSize / 2,
          roll: 0,
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
          // line already — a link stub back to it would only add a line. A
          // placed value hangs one clearance off its own line by construction.
          const placed = glyph.placed === true;
          const link = glyph.leader && glyph.style !== 'aligned' && !placed ? createLinkLine(color) : null;
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
            placed,
            order,
            // A rolled label's screen angle moves with the camera: the hit
            // target hands its own box to the layout so the pick stays on
            // what is drawn (the placement's by-reference rule).
            box: hit,
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
          roll: 0,
          materials: [material],
          baseColor: color,
          onGeometry: true,
        });
        break;
      }

      case 'leader': {
        // One polyline: the dimension line, plus — for a value parked beyond
        // one of its ends — the collinear run out to it, on that end.
        const run: [number, number][] = [glyph.from, glyph.to];
        if (glyph.tail) {
          const [tailFrom, tailTo] = glyph.tail;
          const atStart = Math.hypot(tailFrom[0] - glyph.from[0], tailFrom[1] - glyph.from[1])
            < Math.hypot(tailFrom[0] - glyph.to[0], tailFrom[1] - glyph.to[1]);
          if (atStart) {
            run.unshift(tailTo);
          } else {
            run.push(tailTo);
          }
        }
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(
          run.flatMap((point) => {
            const world = localToWorld(point, plane);
            return [world.x, world.y, world.z];
          }),
          3,
        ));
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
        const placedLine = glyph.placed === true;
        addGroup(group, placedLine);
        // Dashed witness extensions to anchors the leader doesn't reach
        // (axis-locked distances) — same styling as the angle extensions.
        const leaderExt = buildAngleExtensions(glyph.extensions ?? [], plane, color);
        if (leaderExt) {
          addGroup(leaderExt, placedLine);
        }
        const witnessArcs = buildWitnessArcs(glyph.witnessArcs ?? [], plane, color);
        if (witnessArcs) {
          addGroup(witnessArcs, placedLine);
        }
        // Leaders are context, not pick targets — the paired text glyph is.
        break;
      }

      case 'angle-arc': {
        if (glyph.placed) {
          // A placed angle: world-scale arc and helper lines only. The value
          // is its own placed label glyph — it carries the pick target, and
          // the layout reserves its box like any other parked value.
          addGroup(buildPlacedAngleArc(
            { center: glyph.at, radius: glyph.placed.radius, a0: glyph.startAngle, sweep: glyph.sweep },
            plane, color,
          ), true);
          const placedExt = buildAngleExtensions(glyph.extensions, plane, color);
          if (placedExt) {
            addGroup(placedExt, true);
          }
          const witness = glyph.placed.witness
            ? buildWitnessArcs([glyph.placed.witness], plane, color) : null;
          if (witness) {
            addGroup(witness, true);
          }
          break;
        }
        const visual = buildAngleArc(
          glyph.at, glyph.startAngle, glyph.sweep, glyph.label, plane, normal, color, glyph.tails,
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
          dirLocal: [Math.cos(visual.labelAngle), Math.sin(visual.labelAngle)],
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
          roll: 0,
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
