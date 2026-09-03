import type {
  SerializedAssembly,
  SerializedAssemblyMate,
  SerializedReplicateSide,
} from '../../types';
import type { MateRecord } from '../../solver';
import { worldConnectorRef } from '../../solver';
import {
  provisionalReplicaId,
  provisionalReplicaMateId,
  type ProvisionalReplicaSpec,
} from '../../scene/provisional-replicas';

// The pure half of the replicate dialog: which mates a seed carries, which
// of their sides are its OUTER targets (the dialog's columns), and how a
// row of replacement cells becomes the provisional bodies + mates the
// controller previews. Mirrors lib/features/replicate.ts on the serialized
// payload so the preview solves what the kernel will build.

/** The record a replicate statement copies: a root-scope instance or occurrence. */
export type ReplicateSeedRef =
  | { kind: 'instance'; id: string }
  | { kind: 'occurrence'; id: string };

/** One outer target of the seed's mates — a dialog column. */
export type OuterTarget = {
  side: SerializedReplicateSide;
  /** The type of the first mate referencing this target (the column's label). */
  mateType: SerializedAssemblyMate['type'];
  mateId: string;
};

/** Whether an instance id belongs to the seed — itself, or anything under the seed occurrence's path. */
export function seedMembership(seed: ReplicateSeedRef): (instanceId: string) => boolean {
  if (seed.kind === 'instance') {
    return id => id === seed.id;
  }
  const prefix = `${seed.id}/`;
  return id => id === seed.id || id.startsWith(prefix);
}

/** A serialized mate's two sides as replicate sides; null when a side is unresolved. */
export function mateSides(
  mate: SerializedAssemblyMate,
): { a: SerializedReplicateSide; b: SerializedReplicateSide } | null {
  const side = (key: 'A' | 'B'): SerializedReplicateSide | null => {
    const connector = key === 'A' ? mate.connectorA : mate.connectorB;
    if (connector) {
      return { kind: 'connector', instanceId: connector.instanceId, connectorId: connector.connectorId };
    }
    const frame = key === 'A' ? mate.frameA : mate.frameB;
    if (frame) {
      return { kind: 'frame', connectorId: frame.connectorId };
    }
    const geometry = key === 'A' ? mate.geometryA : mate.geometryB;
    if (geometry) {
      return { kind: 'geometry', instanceId: geometry.instanceId, exposeName: geometry.exposeName };
    }
    return null;
  };
  const a = side('A');
  const b = side('B');
  return a && b ? { a, b } : null;
}

export function sideOnSeed(side: SerializedReplicateSide, onSeed: (id: string) => boolean): boolean {
  return side.kind !== 'frame' && onSeed(side.instanceId);
}

export function sameSide(x: SerializedReplicateSide, y: SerializedReplicateSide): boolean {
  if (x.kind === 'connector' && y.kind === 'connector') {
    return x.instanceId === y.instanceId && x.connectorId === y.connectorId;
  }
  if (x.kind === 'frame' && y.kind === 'frame') {
    return x.connectorId === y.connectorId;
  }
  if (x.kind === 'geometry' && y.kind === 'geometry') {
    return x.instanceId === y.instanceId && x.exposeName === y.exposeName;
  }
  return false;
}

/**
 * The mates the statement replicates: every mate of the OPEN file (owner
 * '') with at least one side on the seed, in statement order. Replicated
 * mates are never seed mates (they sit on replicas), but the guard keeps a
 * stale payload honest.
 */
export function seedMates(assembly: SerializedAssembly, seed: ReplicateSeedRef): SerializedAssemblyMate[] {
  const onSeed = seedMembership(seed);
  return assembly.mates.filter((mate) => {
    if ((mate.owner ?? '') !== '' || mate.replica) {
      return false;
    }
    const sides = mateSides(mate);
    return sides !== null && (sideOnSeed(sides.a, onSeed) || sideOnSeed(sides.b, onSeed));
  });
}

/**
 * The seed's internal mates — both sides on the seed, whatever scope they
 * ran in (an occurrence seed's body mates). They re-run with the body, so
 * the preview clones them onto the ghosts.
 */
export function internalMates(assembly: SerializedAssembly, seed: ReplicateSeedRef): SerializedAssemblyMate[] {
  const onSeed = seedMembership(seed);
  return assembly.mates.filter((mate) => {
    const sides = mateSides(mate);
    return sides !== null && sideOnSeed(sides.a, onSeed) && sideOnSeed(sides.b, onSeed);
  });
}

/** The seed's outer sides in mate order, deduplicated — the only legal target columns. */
export function outerTargets(assembly: SerializedAssembly, seed: ReplicateSeedRef): OuterTarget[] {
  const onSeed = seedMembership(seed);
  const out: OuterTarget[] = [];
  for (const mate of seedMates(assembly, seed)) {
    const sides = mateSides(mate);
    if (!sides) {
      continue;
    }
    for (const side of [sides.a, sides.b]) {
      if (!sideOnSeed(side, onSeed) && !out.some(o => sameSide(o.side, side))) {
        out.push({ side, mateType: mate.type, mateId: mate.mateId });
      }
    }
  }
  return out;
}

/** Every instance the seed comprises (an occurrence seed: all under its path). */
export function seedInstanceIds(assembly: SerializedAssembly, seed: ReplicateSeedRef): string[] {
  const onSeed = seedMembership(seed);
  return assembly.instances.filter(i => onSeed(i.instanceId)).map(i => i.instanceId);
}

/** Whether a root-scope record has at least one mate in the open file's scope. */
export function seedHasMates(assembly: SerializedAssembly, seed: ReplicateSeedRef): boolean {
  return seedMates(assembly, seed).length > 0;
}

/** A serialized side as the solver references it. */
function solverSide(side: SerializedReplicateSide): MateRecord['connectorA'] | undefined {
  if (side.kind === 'connector') {
    return { instanceId: side.instanceId, connectorId: side.connectorId };
  }
  if (side.kind === 'frame') {
    return worldConnectorRef({ connectorId: side.connectorId });
  }
  return undefined;
}

function solverGeometry(side: SerializedReplicateSide): MateRecord['geometryA'] | undefined {
  return side.kind === 'geometry' ? { instanceId: side.instanceId, exposeName: side.exposeName } : undefined;
}

function toRecord(
  mateId: string,
  mate: SerializedAssemblyMate,
  a: SerializedReplicateSide,
  b: SerializedReplicateSide,
): MateRecord {
  return {
    mateId,
    type: mate.type,
    connectorA: solverSide(a),
    connectorB: solverSide(b),
    geometryA: solverGeometry(a),
    geometryB: solverGeometry(b),
    options: mate.options,
  };
}

/**
 * The controller's preview spec for the dialog's complete rows: per row,
 * a ghost of every seed instance and the seed's mates re-targeted onto it
 * — inner sides move to the ghost (same connector/exposure: the ghost
 * shares the seed's part), outer sides swap for the row's cell where a
 * column names them and stay where none does. Internal mates (both sides
 * on the seed) are cloned wholesale.
 */
export function buildProvisionalSpec(
  assembly: SerializedAssembly,
  seed: ReplicateSeedRef,
  columns: { side: SerializedReplicateSide; on: boolean }[],
  rows: (SerializedReplicateSide | null)[][],
): ProvisionalReplicaSpec {
  const onSeed = seedMembership(seed);
  const ids = seedInstanceIds(assembly, seed);
  const outer = seedMates(assembly, seed);
  const inner = internalMates(assembly, seed);
  const spec: ProvisionalReplicaSpec = { rows: [] };
  rows.forEach((cells, k) => {
    const complete = columns.every((c, j) => !c.on || cells[j] !== null);
    if (!complete) {
      return;
    }
    const mapId = (id: string) => (onSeed(id) ? provisionalReplicaId(k, id) : id);
    const remap = (side: SerializedReplicateSide): SerializedReplicateSide => {
      if (side.kind === 'frame') {
        return side;
      }
      return { ...side, instanceId: mapId(side.instanceId) };
    };
    const retarget = (side: SerializedReplicateSide): SerializedReplicateSide => {
      if (sideOnSeed(side, onSeed)) {
        return remap(side);
      }
      const j = columns.findIndex(c => c.on && sameSide(c.side, side));
      const cell = j >= 0 ? cells[j] : null;
      return cell ?? side;
    };
    const mates: MateRecord[] = [];
    for (const mate of inner) {
      const sides = mateSides(mate);
      if (!sides) {
        continue;
      }
      mates.push(toRecord(provisionalReplicaMateId(k, mate.mateId), mate, remap(sides.a), remap(sides.b)));
    }
    for (const mate of outer) {
      const sides = mateSides(mate);
      if (!sides) {
        continue;
      }
      // An outer mate with both sides on the seed was already cloned above.
      if (sideOnSeed(sides.a, onSeed) && sideOnSeed(sides.b, onSeed)) {
        continue;
      }
      mates.push(toRecord(provisionalReplicaMateId(k, mate.mateId), mate, retarget(sides.a), retarget(sides.b)));
    }
    spec.rows.push({
      clones: ids.map(id => ({ sourceInstanceId: id, provisionalId: provisionalReplicaId(k, id) })),
      mates,
    });
  });
  return spec;
}
