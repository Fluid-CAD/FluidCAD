import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { SceneObject } from "../common/scene-object.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { Part } from "../features/part.js";
import { anchorFrameFromShape, VertexAnchorSpec } from "../features/shape-anchor.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { SelectionIndex } from "./selection-index.js";
import { attributePick } from "./attribution.js";
import { synthesizeApplyFeature } from "./explain.js";
import {
  ConnectorAnchor,
  PickRef,
  SelectionScene,
  SynthesizeOptions,
  renderConnectorAnchorSuffix,
} from "./types.js";

type Vec3 = { x: number; y: number; z: number };

/**
 * What the anchor becomes: a `connector()` statement (only inside a part),
 * or a hole placement — a named connector inside a part, the bare anchor
 * expression outside one.
 */
export type AnchorPurpose = 'connector' | 'hole';

export type ConnectorAnchorCandidate = {
  anchor: ConnectorAnchor;
  /** `.center()` etc. — append to `args` to form the full source expression. */
  suffix: string;
  frame: { origin: Vec3; xDirection: Vec3; yDirection: Vec3; normal: Vec3 };
  /**
   * The point the hover rail measures the cursor against to pick this
   * anchor — the frame origin, except an arc's center(): the circle center
   * stands a radius off the arc, so the arc's midpoint stands in for it.
   */
  hoverPoint: Vec3;
};

export type ConnectorAnchorSuggestions =
  | {
    ok: true;
    /**
     * Whether the pick sits in a part() of its own file, so committing it
     * creates a connector there. Always true for a connector suggestion.
     */
    inPart: boolean;
    /** A connector name unique within the enclosing part (`c1`, `c2`, …); null outside a part. */
    defaultName: string | null;
    /** Synthesized source selector (no anchor suffix), e.g. `e.endFaces(0)`. */
    args: string;
    /**
     * The file the emitted statement would land in — the picked producers'
     * own file, which under an assembly render is the part's file. Callers
     * building file-coupled synthesis options (namer/params) must read this
     * file, not whichever file is open.
     */
    filePath: string | null;
    anchors: ConnectorAnchorCandidate[];
  }
  | { ok: false; reason: string };

/**
 * The anchors a pick offers, without the selector synthesis: what the hover
 * rail draws. Milliseconds, where {@link suggestConnectorAnchors} runs a
 * filter search over the whole part. Refuses what synthesis would refuse
 * up front — an unresolvable pick, a connector outside a part.
 */
export type ConnectorAnchorFrames =
  | {
    ok: true;
    /**
     * Whether committing the anchor creates a connector in its part. Always
     * true for a connector; for a hole, provisional — the enclosing part()
     * lives in the picked solid's own file — until synthesis confirms it.
     */
    inPart: boolean;
    /** A connector name unique within the enclosing part (`c1`, `c2`, …); null outside a part. */
    defaultName: string | null;
    /**
     * The file a committed statement lands in — the enclosing part()'s own
     * file (synthesis refuses a pick whose producers live elsewhere), or the
     * picked solid's file outside a part. Callers build file-coupled
     * synthesis options (namer/params) over it before the one synthesis pass.
     */
    filePath: string | null;
    anchors: ConnectorAnchorCandidate[];
  }
  | { ok: false; reason: string };

/** The pick's anchors and naming, shared by both suggestion forms. */
type AnchorBasics =
  | {
    ok: true;
    /** A free connector name in the enclosing part, null outside one. */
    allocatedName: string | null;
    partFile: string | null;
    ownerFile: string | null;
    anchors: ConnectorAnchorCandidate[];
  }
  | { ok: false; reason: string };

function anchorBasics(scene: SelectionScene, ref: PickRef, purpose: AnchorPurpose): AnchorBasics {
  const index = new SelectionIndex(scene);
  let picked: Shape | null;
  let solidOwner: SceneObject | null;
  try {
    const attribution = attributePick(scene, index, ref);
    picked = attribution.picked;
    solidOwner = attribution.solidOwner;
  } finally {
    index.dispose();
  }
  if (!picked) {
    return { ok: false, reason: 'pick does not resolve to a sub-shape in the current scene' };
  }

  const enclosing = solidOwner ? scene.findEnclosingPart(solidOwner) : null;
  if (!enclosing && purpose === 'connector') {
    return {
      ok: false,
      reason: 'connectors attach to geometry inside a part() block — wrap the feature statements in part(...)',
    };
  }

  const anchors: ConnectorAnchorCandidate[] = [];
  for (const spec of anchorSpecsForShape(picked)) {
    let frame: Plane;
    try {
      frame = anchorFrameFromShape(picked, spec);
    } catch {
      // e.g. a degenerate edge — skip the anchor rather than failing the hover.
      continue;
    }
    anchors.push({
      anchor: spec,
      suffix: renderConnectorAnchorSuffix(spec),
      frame: {
        origin: toVec3(frame.origin),
        xDirection: toVec3(frame.xDirection),
        yDirection: toVec3(frame.yDirection),
        normal: toVec3(frame.normal),
      },
      hoverPoint: toVec3(hoverPointFor(picked, spec, frame.origin)),
    });
  }
  if (anchors.length === 0) {
    return { ok: false, reason: 'no connector anchor available on this shape' };
  }

  return {
    ok: true,
    allocatedName: enclosing ? allocateConnectorName(enclosing) : null,
    partFile: enclosing?.getSourceLocation()?.filePath ?? null,
    ownerFile: solidOwner?.getSourceLocation()?.filePath ?? null,
    anchors,
  };
}

/**
 * Hover-time anchors for a picked face or edge (face center; edge
 * center/start/end) with their exact frames and a free default name — no
 * selector synthesis, so the hover answers in milliseconds on any model.
 * The source expression is synthesized once, when the pick is committed.
 */
export function suggestConnectorFrames(
  scene: SelectionScene,
  ref: PickRef,
  purpose: AnchorPurpose = 'connector',
): ConnectorAnchorFrames {
  const basics = anchorBasics(scene, ref, purpose);
  if (basics.ok === false) {
    return basics;
  }
  const inPart = purpose === 'connector'
    || (basics.partFile !== null && basics.partFile === basics.ownerFile);
  return {
    ok: true,
    inPart,
    defaultName: inPart ? basics.allocatedName : null,
    filePath: inPart ? basics.partFile : basics.ownerFile,
    anchors: basics.anchors,
  };
}

/**
 * Connector suggestions for a picked face or edge: the anchors the tool can
 * snap to (face center; edge center/start/end) with their exact frames,
 * plus the synthesized source expression and a free default name. A
 * connector needs an enclosing part; a hole placement does not. Read-only
 * over a built scene — the apply route re-synthesizes on commit.
 */
export function suggestConnectorAnchors(
  scene: SelectionScene,
  ref: PickRef,
  options: SynthesizeOptions = {},
  purpose: AnchorPurpose = 'connector',
): ConnectorAnchorSuggestions {
  const basics = anchorBasics(scene, ref, purpose);
  if (basics.ok === false) {
    return basics;
  }

  // Reuse the full synthesis pipeline (part scoping, file checks, selector
  // ranking) with the kind the commit synthesizes — the default name is
  // unique, so the connector name guards always pass.
  const synthesis = synthesizeApplyFeature(
    scene, [ref], purpose, purpose === 'connector' ? basics.allocatedName : undefined, [], options,
  );
  if (synthesis.ok === false) {
    return { ok: false, reason: synthesis.reason };
  }
  // A hole makes a connector only in a part of the pick's own file — the
  // part the synthesis reports, exactly as the apply route decides.
  const inPart = purpose === 'connector' || synthesis.spec.hole?.part !== undefined;

  return {
    ok: true,
    inPart,
    defaultName: inPart ? basics.allocatedName : null,
    args: synthesis.args,
    filePath: synthesis.spec.filePath ?? null,
    anchors: basics.anchors,
  };
}

function anchorSpecsForShape(shape: Face | Edge | { getType(): string }): VertexAnchorSpec[] {
  if (shape instanceof Face) {
    return [{ kind: 'center' }];
  }
  if (shape instanceof Edge) {
    // A closed edge (full circle) has no meaningful start/end — its seam is a
    // parameterization artifact. Arcs and open curves get all three.
    if (EdgeQuery.isEdgeClosedCurve(shape)) {
      return [{ kind: 'center' }];
    }
    return [{ kind: 'center' }, { kind: 'start' }, { kind: 'end' }];
  }
  return [];
}

/**
 * Where the cursor is measured against an anchor. An arc's center() is the
 * circle center, a radius off the arc the user hovers — measured there it
 * would lose to start()/end() along the whole arc. The arc's midpoint stands
 * in for it, splitting the arc between center, start and end the way a
 * straight edge already splits.
 */
function hoverPointFor(shape: Shape, spec: VertexAnchorSpec, origin: Point): Point {
  if (spec.kind === 'center' && shape instanceof Edge && EdgeQuery.isArcEdge(shape)) {
    return EdgeOps.getEdgeMidPoint(shape);
  }
  return origin;
}

function allocateConnectorName(part: unknown): string {
  const taken = part instanceof Part ? part.getNamedConnectors() : {};
  for (let i = 1; ; i++) {
    const candidate = `c${i}`;
    if (!taken[candidate]) {
      return candidate;
    }
  }
}

function toVec3(v: { x: number; y: number; z: number }): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}
