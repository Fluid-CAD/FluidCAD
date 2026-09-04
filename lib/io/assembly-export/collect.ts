import { AssemblyScene } from "../../rendering/assembly-scene.js";
import { Part } from "../../features/part.js";
import { Solid } from "../../common/solid.js";
import { IDENTITY_POSE, relativePose } from "../../math/pose.js";
import type { Pose } from "../../math/pose.js";
import type { AssemblyExportNode, AssemblyExportPart, AssemblyExportPose, AssemblyExportTree } from "./tree.js";

export type CollectAssemblyOptions = {
  /** The root product's name. */
  name: string;
  /**
   * Live world poses, one per instance. When given they must cover every
   * instance in the scene — a partial list would silently mix solved and
   * unsolved placement, so it is refused instead.
   */
  livePoses?: AssemblyExportPose[];
};

export type CollectAssemblyResult =
  | { ok: true; tree: AssemblyExportTree }
  | { ok: false; reason: string };

/**
 * Builds the export tree of an assembly scene: statement poses from the
 * scene (occurrence chain composed), instance poses overridden by the
 * client's live ones when present, each expressed LOCAL to its owner so
 * nesting survives while the geometry lands exactly where the solver put
 * it. Part templates are collected once per `Part.id` via the same
 * scope-less read the features use (hard removals honoured, meta and guide
 * shapes excluded).
 */
export function collectAssemblyExportTree(scene: AssemblyScene, options: CollectAssemblyOptions): CollectAssemblyResult {
  const instances = scene.getSerializedInstances();
  const occurrences = scene.getSerializedOccurrences();

  const live = new Map<string, Pose>();
  if (options.livePoses !== undefined) {
    const known = new Set(instances.map(i => i.instanceId));
    for (const pose of options.livePoses) {
      if (!known.has(pose.instanceId)) {
        return { ok: false, reason: `Unknown instance "${pose.instanceId}" in the live poses.` };
      }
      live.set(pose.instanceId, { position: pose.position, quaternion: pose.quaternion });
    }
    const missing = instances.filter(i => !live.has(i.instanceId));
    if (missing.length > 0) {
      const names = missing.slice(0, 3).map(i => i.name).join(", ");
      const more = missing.length > 3 ? ` and ${missing.length - 3} more` : "";
      return { ok: false, reason: `Live poses are missing for ${names}${more} — the export needs one per instance.` };
    }
  }

  const partsById = new Map<string, Part>();
  for (const object of scene.getAllSceneObjects()) {
    if (object instanceof Part) {
      partsById.set(object.id, object);
    }
  }

  const parts = new Map<string, AssemblyExportPart>();
  for (const inst of instances) {
    if (parts.has(inst.partId)) {
      continue;
    }
    const part = partsById.get(inst.partId);
    if (!part) {
      return { ok: false, reason: `The part of instance "${inst.name}" is not in the scene.` };
    }
    const solids = part.getShapes(undefined, "solid").filter((s): s is Solid => s.isSolid());
    parts.set(inst.partId, { partId: inst.partId, name: inst.partName, solids });
  }

  const world = scene.occurrenceWorldPoses();
  const occurrenceNodes = new Map<string, Extract<AssemblyExportNode, { kind: 'occurrence' }>>();
  const rootChildren: AssemblyExportNode[] = [];
  const childrenOf = (owner: string): AssemblyExportNode[] =>
    owner === "" ? rootChildren : (occurrenceNodes.get(owner)?.children ?? rootChildren);

  // Occurrences arrive parent-first (insert order nests), so a parent's node
  // exists before its children look it up.
  for (const occ of occurrences) {
    const node: Extract<AssemblyExportNode, { kind: 'occurrence' }> = {
      kind: 'occurrence',
      occurrenceId: occ.occurrenceId,
      name: occ.name,
      pose: { position: occ.position, quaternion: occ.quaternion },
      children: [],
    };
    occurrenceNodes.set(occ.occurrenceId, node);
    childrenOf(occ.parentPath).push(node);
  }

  for (const inst of instances) {
    const worldPose = live.get(inst.instanceId) ?? { position: inst.position, quaternion: inst.quaternion };
    const ownerWorld = world.get(inst.owner) ?? IDENTITY_POSE;
    childrenOf(inst.owner).push({
      kind: 'instance',
      instanceId: inst.instanceId,
      name: inst.name,
      partId: inst.partId,
      pose: relativePose(ownerWorld, worldPose),
    });
  }

  return {
    ok: true,
    tree: {
      name: options.name,
      unit: scene.unit,
      parts,
      children: rootChildren,
      posesSource: options.livePoses !== undefined ? 'live' : 'statement',
    },
  };
}
