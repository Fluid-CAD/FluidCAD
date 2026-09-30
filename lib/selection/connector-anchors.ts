import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Shape } from "../common/shape.js";
import { SceneObject } from "../common/scene-object.js";
import { Plane } from "../math/plane.js";
import { Part } from "../features/part.js";
import { anchorFrameFromShape, VertexAnchorSpec } from "../features/shape-anchor.js";
import { EdgeQuery } from "../oc/edge-query.js";
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
 * Hover-time connector suggestions for a picked face or edge: the anchors the
 * tool can snap to (face center; edge center/start/end) with their exact
 * frames, plus the synthesized source expression and a free default name.
 * A connector needs an enclosing part; a hole placement does not. Read-only
 * over a built scene — the apply route re-synthesizes on commit.
 */
export function suggestConnectorAnchors(
  scene: SelectionScene,
  ref: PickRef,
  options: SynthesizeOptions = {},
  purpose: AnchorPurpose = 'connector',
): ConnectorAnchorSuggestions {
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
  const defaultName = enclosing ? allocateConnectorName(enclosing) : null;

  // Reuse the full synthesis pipeline (part scoping, file checks, selector
  // ranking) with the kind the commit synthesizes — the default name is
  // unique, so the connector name guards always pass.
  const synthesis = synthesizeApplyFeature(scene, [ref], purpose, purpose === 'connector' ? defaultName : undefined, [], options);
  if (synthesis.ok === false) {
    return { ok: false, reason: synthesis.reason };
  }
  // A hole makes a connector only in a part of the pick's own file — the
  // part the synthesis reports, exactly as the apply route decides.
  const inPart = purpose === 'connector' || synthesis.spec.hole?.part !== undefined;

  const specs = anchorSpecsForShape(picked);
  const anchors: ConnectorAnchorCandidate[] = [];
  for (const spec of specs) {
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
    });
  }
  if (anchors.length === 0) {
    return { ok: false, reason: 'no connector anchor available on this shape' };
  }

  return {
    ok: true,
    inPart,
    defaultName: inPart ? defaultName : null,
    args: synthesis.args,
    filePath: synthesis.spec.filePath ?? null,
    anchors,
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
