import { SceneObject } from "./scene-object.js";
import { Shape, ShapeFilter } from "./shape.js";
import { BuildError } from "./build-error.js";
import { heldBodiesOf, liveOperandShapes } from "../helpers/live-solids.js";
import type { BodyShape } from "./body-shape.js";
import type { Edge } from "./edge.js";
import type { Face } from "./face.js";

/** What an operand can stand for, in the words a user reads: a solid, a surface or a curve. */
export type OperandKind = 'solid' | 'surface' | 'curve';

interface RequireShapesOpts {
  /** Require exactly this many shapes. */
  count?: number;
  /** Require every shape to be of this type. */
  type?: string;
  /** Require every shape to be of one of these kinds; a face or anything else is refused too. */
  kinds?: OperandKind | readonly OperandKind[];
  /** The hint of a {@link kinds} refusal, when the consumer knows the fix ("thicken it first"). */
  kindHint?: string;
  /** Shape filter — pass { excludeGuide: false } when the consumer's build also reads guide shapes. */
  filter?: ShapeFilter;
}

/** The kind a shape stands for as an operand: its body kind, a curve for an edge or a wire, null for anything else. */
export function operandKindOf(shape: Shape): OperandKind | null {
  if (shape.isSolid()) {
    return 'solid';
  }
  if (shape.isBody()) {
    return 'surface';
  }
  if (shape.isEdge() || shape.isWire()) {
    return 'curve';
  }
  return null;
}

/**
 * The one wording of "this tool needs a solid, you gave a surface", so every
 * such refusal reads the same and names the operand: "fuse: target is a
 * surface; fuse works on solids." `given` is the kind found, or the shape
 * type when it is no operand kind (a face). `verb` is "holds" when the
 * operand is a selection of which only some members are refused.
 */
export function operandKindError(
  consumerType: string,
  operandLabel: string,
  given: string,
  wanted: OperandKind | readonly OperandKind[],
  hint?: string,
  verb: 'is' | 'holds' = 'is',
): BuildError {
  const kinds = typeof wanted === 'string' ? [wanted] : wanted;
  const plural = kinds.map(kind => `${kind}s`).join(' or ');
  return new BuildError(
    `${consumerType}: ${operandLabel} ${verb} ${/^[aeiou]/.test(given) ? 'an' : 'a'} ${given}; ${consumerType} works on ${plural}.`,
    hint ?? `Pass ${kinds.map(kind => `a ${kind}`).join(' or ')} as ${operandLabel}.`,
  );
}

/**
 * Validate that an operand SceneObject still owns shapes the consumer can use,
 * and produce a uniform diagnostic when it doesn't.
 *
 * A solid an earlier op took from the operand counts as owned while that op
 * made something of it: `translate(amount, target)` moves the body onto the
 * translate object, a fillet rebuilds it, a boss fuses it — and a consumer
 * reading the operand gets the body as those features left it (see
 * `liveOperandShapes`). Only a body nothing stands for any more — cut away,
 * or taken by `remove()` — fails here. `getRemovedShapes()` records who took
 * each shape, so the error names that consumer.
 */
export function requireShapes(
  obj: SceneObject,
  operandLabel: string,
  consumerType: string,
  opts?: RequireShapesOpts,
): Shape[] {
  // Lazy operands (LazySelectionSceneObject, LazyVertex) only populate their
  // shapes during build. Their pre-build emptiness is expected, so skip —
  // the build itself still validates them.
  if (obj.isLazy()) {
    return [];
  }

  const shapes = liveOperandShapes(obj, opts?.filter).map(entry => entry.shape);

  if (shapes.length === 0) {
    const removed = obj.getRemovedShapes();
    const objLabel = `${operandLabel} (${obj.getType()})`;
    if (removed.length > 0) {
      const consumers = [...new Set(removed.map(r => r.removedBy.getType()))].join(", ");
      throw new BuildError(
        `${consumerType}: ${objLabel} has no shapes — its geometry was consumed by ${consumers}.`,
        `Reference the result of ${consumers} as the operand instead of ${obj.getType()}.`,
      );
    }
    throw new BuildError(
      `${consumerType}: ${objLabel} has no shapes.`,
      `Make sure the upstream operation produced geometry.`,
    );
  }

  if (opts?.count !== undefined && shapes.length !== opts.count) {
    throw new BuildError(
      `${consumerType}: ${operandLabel} has ${shapes.length} shapes, expected ${opts.count}.`,
    );
  }

  if (opts?.kinds) {
    const wanted = typeof opts.kinds === 'string' ? [opts.kinds] : opts.kinds;
    for (const shape of shapes) {
      const kind = operandKindOf(shape);
      if (kind === null || !wanted.includes(kind)) {
        throw operandKindError(consumerType, operandLabel, kind ?? shape.getType(), wanted, opts.kindHint);
      }
    }
  }

  if (opts?.type) {
    const wrong = shapes.find(s => s.getType() !== opts.type);
    if (wrong) {
      throw new BuildError(
        `${consumerType}: ${operandLabel} has a shape of type '${wrong.getType()}', expected '${opts.type}'.`,
      );
    }
  }

  return shapes;
}

/** The fix a boolean's surface refusal offers. */
export const BOOLEAN_SURFACE_HINT = "Booleans work on solids: a surface has no volume to add, keep or remove. Pass the solid to combine.";

/**
 * Refuse a named operand of a solid-only tool (a boolean, a split) that
 * stands for a surface and no solid. Such a tool reads only the operand's
 * solids, so it would otherwise do nothing — or, as a boolean's stock, take
 * the surface away and add nothing. An operand holding a solid beside a
 * surface still gives its solids.
 */
export function requireSolidOperand(obj: SceneObject, operandLabel: string, consumerType: string, hint: string): void {
  if (obj.isLazy()) {
    return;
  }
  const shapes = liveOperandShapes(obj).map(entry => entry.shape);
  if (!shapes.some(shape => shape.isSolid()) && shapes.some(shape => shape.isSheet())) {
    throw operandKindError(consumerType, operandLabel, 'surface', 'solid', hint);
  }
}

/** The fix a fillet's or chamfer's refusal of an edge off a solid offers. */
const SOLID_EDGES_HINT = "Add .ofSolid() to the filter — select(edge().ofSolid()…) — to keep only the solids' edges.";

/**
 * The tools that reshape solids through a selection of their edges or
 * faces, each with what it calls a selection in a refusal and the fix it
 * offers. The one list the builds, the dialogs' previews and the
 * pick-to-code synthesis refuse by, so a selection off a solid is refused
 * for the same tools in the same words wherever it is caught.
 */
const SOLID_RESHAPERS = {
  fillet: { selection: 'edge selection', hint: SOLID_EDGES_HINT },
  chamfer: { selection: 'edge selection', hint: SOLID_EDGES_HINT },
  shell: {
    selection: 'face selection',
    hint: "shell hollows a solid; a surface has no inside to hollow. Select faces of a solid.",
  },
  draft: { selection: 'selection', hint: "draft tilts the faces of a solid. Select faces of a solid." },
} as const;

/** A tool that reshapes solids: a fillet, a chamfer, a shell, a draft. */
export type SolidReshaper = keyof typeof SOLID_RESHAPERS;

export function isSolidReshaper(consumerType: string): consumerType is SolidReshaper {
  return Object.hasOwn(SOLID_RESHAPERS, consumerType);
}

/**
 * What an edge or a face reads as in a solid reshaper's refusal when the
 * shape it lies on is no solid — "surface edge", "surface face", "curve
 * edge" — or null on a solid. For the callers that know the shape a pick
 * was made on: the pick-to-code synthesis and the previews. A build finds a
 * surface's parts among the bodies in reach ({@link refuseSurfaceParts}).
 */
export function offSolidPart(owner: Shape, part: 'edge' | 'face'): string | null {
  const kind = operandKindOf(owner);
  return kind === 'surface' || kind === 'curve' ? `${kind} ${part}` : null;
}

/**
 * The refusal of a selection that holds something off a solid, handed to a
 * tool that reshapes solids: "fillet: edge selection 1 holds a surface
 * edge; fillet works on solids." `given` is what was found (see
 * {@link offSolidPart}); `position` counts the tool's selections from 0. A
 * dialog's picks make one selection, the first.
 */
export function offSolidRefusal(consumerType: SolidReshaper, given: string, position = 0): BuildError {
  const { selection, hint } = SOLID_RESHAPERS[consumerType];
  return operandKindError(consumerType, `${selection} ${position + 1}`, given, 'solid', hint, 'holds');
}

/**
 * Refuse faces or edges of a surface handed to a tool that reshapes solids:
 * skipping them would leave the user to guess why nothing happened.
 * `shapes` are what the selection holds — faces, edges, or whole bodies —
 * `position` its place among the tool's selections, from 0, and `scope` the
 * objects whose bodies are in reach. A curve's edge is not looked for here:
 * a build holds the edge alone, and nothing in reach tells a curve's edge
 * from one a selection or a sketch also holds, or one a later feature
 * consumed. The build reports it with the edges that matched no solid; the
 * callers that know the shape a pick was made on refuse it by
 * {@link offSolidPart}.
 */
export function refuseSurfaceParts(
  consumerType: SolidReshaper,
  position: number,
  shapes: readonly Shape[],
  scope: SceneObject[],
): void {
  if (shapes.length === 0) {
    return;
  }
  let sheets: BodyShape[] | null = null;
  for (const shape of shapes) {
    let given: string | null = null;
    if (shape.isSheet()) {
      given = 'surface';
    } else if (shape.isEdge() || shape.isFace()) {
      sheets ??= heldBodiesOf(scope).map(({ body }) => body).filter(body => body.isSheet()) as BodyShape[];
      const onSheet = shape.isEdge()
        ? sheets.some(sheet => !!sheet.hasEdge((shape as Edge).getShape()))
        : sheets.some(sheet => sheet.hasFace((shape as Face).getShape()));
      if (onSheet) {
        given = `surface ${shape.isEdge() ? 'edge' : 'face'}`;
      }
    }
    if (given) {
      throw offSolidRefusal(consumerType, given, position);
    }
  }
}
