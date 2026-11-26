import type { ColoredBody } from "../../common/colored-body.js";
import type { Solid } from "../../common/solid.js";
import type { LengthUnit } from "../../units/units.js";
import type { Pose } from "../../math/pose.js";

/**
 * A live instance pose handed in by a viewer — where its own solve has the
 * part after drags, mate drives and the animate bar, motion the engine
 * never sees otherwise. World frame, in the assembly's unit.
 */
export type AssemblyExportPose = Pose & { instanceId: string };

/**
 * Where an export's instance poses came from: `live` — the viewer's, handed
 * in; `solved` — the engine's own mate solve from the statement poses;
 * `statement` — the source's `insert()` chains alone, because that solve
 * could not run.
 */
export type AssemblyExportPosesSource = 'live' | 'solved' | 'statement';

/** One part template: exported once, referenced by every instance of it. */
export type AssemblyExportPart = {
  partId: string;
  name: string;
  /** The template's exportable solids, in the part's own frame, each with its resolved colours. */
  solids: ColoredBody<Solid>[];
};

/**
 * The export's view of the assembly: a tree whose poses are LOCAL to the
 * parent node (the root frame is the world), so a STEP writer can emit
 * nested components verbatim and a flattening writer composes on the way
 * down.
 */
export type AssemblyExportNode =
  | { kind: 'instance'; instanceId: string; name: string; partId: string; pose: Pose }
  | { kind: 'occurrence'; occurrenceId: string; name: string; pose: Pose; children: AssemblyExportNode[] };

export type AssemblyExportTree = {
  /** The root product's name — the assembly file's base name. */
  name: string;
  /** The unit every number in the tree is in. */
  unit: LengthUnit;
  parts: Map<string, AssemblyExportPart>;
  children: AssemblyExportNode[];
  posesSource: AssemblyExportPosesSource;
};

/** Whether anything under `node` has geometry to write. */
export function nodeHasSolids(node: AssemblyExportNode, parts: Map<string, AssemblyExportPart>): boolean {
  if (node.kind === 'instance') {
    return (parts.get(node.partId)?.solids.length ?? 0) > 0;
  }
  return node.children.some(child => nodeHasSolids(child, parts));
}
