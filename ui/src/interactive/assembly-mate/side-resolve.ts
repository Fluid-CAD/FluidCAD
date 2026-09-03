import type { AssemblyMateConnectorRef, AssemblyMateViaEntry } from '../../api';
import type { ReplicaTag, SerializedAssembly, SerializedAssemblyInstance, SerializedAssemblyOccurrence } from '../../types';

// Mate-side resolution shared by the mate dialog and the replicate dialog:
// a picked connector gizmo (or an assembly connector) becomes a slot state
// carrying the live scene ids plus the stable source address the statement
// is written against; a state re-resolves after a render re-minted the ids;
// and a state renders into the writer's side ref (`instanceLine` +
// `connectorName`, `.parts` export chain for nested picks, `replicaRow` for
// a replica whose statement is a `replicate()` call).

/**
 * One picked part connector: the live scene ids (refreshed per render — the
 * renderer re-mints them) plus the stable source address the statement is
 * written against and the picks re-resolve by.
 */
export type ConnectorSlotState = {
  kind: 'connector';
  instanceId: string;
  connectorId: string;
  /**
   * 1-based row of the anchor statement: the instance's `insert()` chain,
   * or — for a replica — the `replicate()` statement that produced it.
   */
  instanceLine: number;
  connectorName: string;
  instanceName: string;
  /** The assembly file the anchor statement lives in. */
  filePath: string;
  /**
   * Owning scope path: '' for instances the open file inserts directly, an
   * occurrence path ('asm-0', 'asm-0/asm-1') for picks inside a
   * sub-assembly. Nested picks anchor the statement on the top OCCURRENCE's
   * insert() and reach the connector through `.parts` export chains — see
   * {@link resolveSideChain}.
   */
  owner: string;
  /** The top-level occurrence's display name (chip prefix); null at root. */
  ownerLabel: string | null;
  /**
   * The anchor is a replica: `instanceLine` is its `replicate()` statement
   * and this is the 0-based row that produced it (the root instance itself,
   * or the top occurrence of a nested pick).
   */
  replicaRow?: number;
};

/**
 * An assembly connector filling a slot (`connector('name', [x, y, z])` at
 * the assembly's top level): addressed by its statement's file and line
 * for the writer, re-found by name after a render re-mints scene ids.
 */
export type WorldSlotState = {
  kind: 'world';
  connectorId: string;
  connectorName: string;
  connectorLine: number;
  filePath: string;
};

export type MateSlotState = ConnectorSlotState | WorldSlotState;

/**
 * An exposure addressed by name on an instance (`instance.features.<name>`)
 * — the replicate dialog's tangent-column cells, which reference existing
 * exposures only.
 */
export type GeometrySlotState = {
  kind: 'geometry';
  instanceId: string;
  instanceLine: number;
  instanceName: string;
  filePath: string;
  exposeName: string;
  owner: string;
  replicaRow?: number;
};

/**
 * A connector side resolved for writing: the statement's anchor (the
 * instance's own insert(), the top occurrence of a nested pick, or the
 * replicate() statement of a replica) plus the `.parts` levels the server
 * dereferences — with `createFrom` for levels whose sub-assembly doesn't
 * export the next handle yet.
 */
export type ResolvedSideChain = {
  /** The file the anchor statement lives in — the statement's target file. */
  filePath: string;
  instanceLine: number;
  viaParts?: AssemblyMateViaEntry[];
  replicaRow?: number;
};

/** The controller surface the resolvers read connector names/ids through. */
export type ConnectorLookup = {
  getConnectorName(connectorId: string): string | null;
  findConnectorId(instanceId: string, connectorName: string): string | null;
};

/** The top-level occurrence an owned instance lives under, or undefined at root. */
export function topOccurrenceOf(
  assembly: SerializedAssembly | null,
  owner: string,
): SerializedAssemblyOccurrence | undefined {
  if (!owner) {
    return undefined;
  }
  return assembly?.occurrences?.find(o => o.occurrenceId === owner.split('/')[0]);
}

/** A clicked connector gizmo → the slot state, or the reason it can't be used. */
export function resolveConnectorPick(
  assembly: SerializedAssembly | null,
  lookup: ConnectorLookup | null | undefined,
  connectorId: string,
  instanceId: string | null,
): ConnectorSlotState | { error: string } {
  const instance = instanceId
    ? assembly?.instances.find(i => i.instanceId === instanceId)
    : undefined;
  if (!instance) {
    return { error: 'Could not resolve the connector to an instance — try re-rendering.' };
  }
  if (!instance.sourceLocation) {
    return { error: `${instance.name} has no source location — its insert() cannot be referenced.` };
  }
  const name = lookup?.getConnectorName(connectorId);
  if (!name) {
    return { error: 'This connector has no name — its statement failed to build.' };
  }
  const owner = instance.owner ?? '';
  const topOccurrence = topOccurrenceOf(assembly, owner);
  const replica = owner ? topOccurrence?.replica : instance.replica;
  return {
    kind: 'connector',
    instanceId: instance.instanceId,
    connectorId,
    instanceLine: instance.sourceLocation.line,
    connectorName: name,
    instanceName: instance.name,
    filePath: instance.sourceLocation.filePath,
    owner,
    ownerLabel: topOccurrence?.name ?? null,
    ...(replica && !owner ? { replicaRow: replica.row } : {}),
  };
}

/** A clicked assembly-connector gizmo → the slot state, or why it can't be used. */
export function resolveWorldPick(
  assembly: SerializedAssembly | null,
  connectorId: string,
): WorldSlotState | { error: string } {
  const connector = assembly?.connectors?.find(c => c.connectorId === connectorId);
  if (!connector) {
    return { error: 'Could not resolve the assembly connector — try re-rendering.' };
  }
  if (!connector.sourceLocation) {
    return { error: `${connector.name} has no source location — its connector() cannot be referenced.` };
  }
  return {
    kind: 'world',
    connectorId,
    connectorName: connector.name,
    connectorLine: connector.sourceLocation.line,
    filePath: connector.sourceLocation.filePath,
  };
}

/**
 * An exposure named on an instance → the geometry slot state, or why it
 * can't be used. Owned instances are refused: tangent sides can't reach
 * through `.parts` yet, so the address must be the instance's own line.
 */
export function resolveExposureCell(
  assembly: SerializedAssembly | null,
  hasExposure: (instanceId: string, exposeName: string) => boolean,
  instanceId: string,
  exposeName: string,
): GeometrySlotState | { error: string } {
  const instance = assembly?.instances.find(i => i.instanceId === instanceId);
  if (!instance) {
    return { error: 'Could not resolve the geometry to an instance — try re-rendering.' };
  }
  if (!instance.sourceLocation) {
    return { error: `${instance.name} has no source location — its insert() cannot be referenced.` };
  }
  if (instance.owner) {
    return { error: `${instance.name} lives inside a sub-assembly — tangent sides can't reach through .parts yet.` };
  }
  if (!hasExposure(instanceId, exposeName)) {
    return { error: `${instance.name} does not publish expose('${exposeName}') — re-render and try again.` };
  }
  return {
    kind: 'geometry',
    instanceId,
    instanceLine: instance.sourceLocation.line,
    instanceName: instance.name,
    filePath: instance.sourceLocation.filePath,
    exposeName,
    owner: '',
    ...(instance.replica ? { replicaRow: instance.replica.row } : {}),
  };
}

/**
 * The instance a stable address names in the current render: the anchor
 * line + file, the owner path (two occurrences of one sub-assembly share
 * their instances' insert() lines, so line alone would match the first
 * twin), and the replica row (every replica of a statement shares its line).
 */
export function findInstanceByAddress(
  assembly: SerializedAssembly,
  address: { instanceLine: number; filePath: string; owner: string; replicaRow?: number },
): SerializedAssemblyInstance | undefined {
  return assembly.instances.find((i) => {
    if (i.sourceLocation?.line !== address.instanceLine || i.sourceLocation?.filePath !== address.filePath) {
      return false;
    }
    if ((i.owner ?? '') !== address.owner) {
      return false;
    }
    const row = address.owner
      ? topOccurrenceOf(assembly, address.owner)?.replica?.row
      : i.replica?.row;
    return row === address.replicaRow;
  });
}

/** Re-resolve a pick against the fresh render's ids; null when gone. */
export function reresolveSlot(
  assembly: SerializedAssembly | null,
  lookup: ConnectorLookup | null | undefined,
  state: MateSlotState,
): MateSlotState | null {
  if (state.kind === 'world') {
    const fresh = assembly?.connectors?.find(c => c.name === state.connectorName);
    if (!fresh || !fresh.sourceLocation) {
      return null;
    }
    return {
      ...state,
      connectorId: fresh.connectorId,
      connectorLine: fresh.sourceLocation.line,
      filePath: fresh.sourceLocation.filePath,
    };
  }
  if (!assembly || !lookup) {
    return null;
  }
  const instance = findInstanceByAddress(assembly, state);
  if (!instance || !instance.sourceLocation) {
    return null;
  }
  const connectorId = lookup.findConnectorId(instance.instanceId, state.connectorName);
  if (!connectorId) {
    return null;
  }
  return {
    ...state,
    instanceId: instance.instanceId,
    connectorId,
    instanceName: instance.name,
  };
}

/** Re-resolve a geometry cell against the fresh render; null when gone. */
export function reresolveGeometry(
  assembly: SerializedAssembly | null,
  hasExposure: (instanceId: string, exposeName: string) => boolean,
  state: GeometrySlotState,
): GeometrySlotState | null {
  if (!assembly) {
    return null;
  }
  const instance = findInstanceByAddress(assembly, state);
  if (!instance) {
    return null;
  }
  const fresh = resolveExposureCell(assembly, hasExposure, instance.instanceId, state.exposeName);
  return 'error' in fresh ? null : fresh;
}

/** Whether two picks name the same connector (same statement, name, scope and replica). */
export function sameConnectorSlot(a: MateSlotState | null, b: ConnectorSlotState): boolean {
  return a !== null
    && a.kind === 'connector'
    && a.instanceLine === b.instanceLine
    && a.connectorName === b.connectorName
    // Same line + name on DIFFERENT occurrences of one sub-assembly are
    // two distinct connectors — mating them is the whole point.
    && a.owner === b.owner
    && a.replicaRow === b.replicaRow;
}

/**
 * How the statement will reference a pick: directly through the
 * instance's own anchor binding for root-scope picks, or — for a pick
 * inside a sub-assembly — anchored on the top-level OCCURRENCE's statement
 * and reaching down through each level's `.parts` export chain. A level
 * whose sub-assembly doesn't export the next handle resolves to
 * `createFrom` (the server adds the export before writing the statement).
 * A replica anchor carries its row.
 */
export function resolveSideChain(
  assembly: SerializedAssembly | null,
  state: ConnectorSlotState,
): ResolvedSideChain | { error: string } {
  if (!state.owner) {
    return {
      filePath: state.filePath,
      instanceLine: state.instanceLine,
      ...(state.replicaRow !== undefined ? { replicaRow: state.replicaRow } : {}),
    };
  }
  const occurrences = assembly?.occurrences;
  // 'asm-0/asm-1' → ['asm-0', 'asm-0/asm-1']: the occurrence chain from
  // the open file down to the pick's owner.
  const segments = state.owner.split('/');
  const chain = segments.map((_, i) => {
    const id = segments.slice(0, i + 1).join('/');
    return occurrences?.find(o => o.occurrenceId === id);
  });
  if (chain.some(occ => occ === undefined)) {
    return { error: 'Could not resolve the pick\'s sub-assembly — try re-rendering.' };
  }
  const top = chain[0]!;
  if (!top.sourceLocation) {
    return { error: `${top.name} has no source location — its insert() cannot be referenced.` };
  }
  const viaParts: AssemblyMateViaEntry[] = [];
  for (let i = 0; i < chain.length; i++) {
    const occ = chain[i]!;
    // The handle occ must export at this level: the next occurrence down,
    // or — at the last level — the picked instance itself.
    const next = i + 1 < chain.length
      ? { match: (e: { occurrenceId?: string }) => e.occurrenceId === chain[i + 1]!.occurrenceId,
        label: chain[i + 1]!.name, location: chain[i + 1]!.sourceLocation }
      : { match: (e: { instanceId?: string }) => e.instanceId === state.instanceId,
        label: state.instanceName,
        location: { filePath: state.filePath, line: state.instanceLine } };
    if (occ.exports === undefined) {
      return { error: `This engine build predates sub-assembly exports — update fluidcad to mate into ${occ.name}.` };
    }
    const exported = occ.exports.find(next.match);
    if (exported) {
      viaParts.push({ keys: exported.path });
      continue;
    }
    if (!next.location) {
      return { error: `${next.label} has no source location — its insert() cannot be referenced.` };
    }
    viaParts.push({ createFrom: { filePath: next.location.filePath, insertLine: next.location.line } });
  }
  return {
    filePath: top.sourceLocation.filePath,
    instanceLine: top.sourceLocation.line,
    viaParts,
    ...(top.replica ? { replicaRow: top.replica.row } : {}),
  };
}

/** The writer's connector side ref for a resolved pick. */
export function connectorRefFor(state: ConnectorSlotState, chain: ResolvedSideChain): AssemblyMateConnectorRef {
  return {
    instanceLine: chain.instanceLine,
    connectorName: state.connectorName,
    ...(chain.viaParts ? { viaParts: chain.viaParts } : {}),
    ...(chain.replicaRow !== undefined ? { replicaRow: chain.replicaRow } : {}),
  };
}

/**
 * `.parts.left.p1` for an export key path; a numeric key indexes
 * (`.parts.copies[1]` — the handles a `replicate()` returned inside a body
 * are array entries). An empty path is a callback that returned the handle
 * bare: `.parts` alone.
 */
export function renderPartsPath(keys: string[]): string {
  return `.parts${keys.map(k => (/^\d+$/.test(k) ? `[${k}]` : `.${k}`)).join('')}`;
}

/**
 * The display stand-in for a replica anchor: `<seed>Replicas[row]`, the
 * binding the writer hoists onto a bare replicate statement (its real name
 * is the seed's binding; the display name is the closest thing the client
 * knows).
 */
export function replicaAnchorLabel(assembly: SerializedAssembly | null, seedLabel: string, tag: ReplicaTag): string {
  const statement = assembly?.replicates?.find(r => r.replicateId === tag.statement);
  const seed = statement
    ? (statement.seed.instanceId !== undefined
      ? assembly?.instances.find(i => i.instanceId === statement.seed.instanceId)?.name
      : assembly?.occurrences?.find(o => o.occurrenceId === statement.seed.occurrenceId)?.name)
    : undefined;
  return `${seed ?? seedLabel}Replicas[${tag.row}]`;
}

/**
 * The statement-preview text for a connector pick (display names stand in
 * for bindings — the server writes the truth): a root pick dereferences its
 * instance, a nested pick previews its `.parts` export chain (`…` marking a
 * key the server will export on Apply), a replica anchor shows as
 * `<seed>Replicas[row]`.
 */
export function previewConnectorRef(assembly: SerializedAssembly | null, state: ConnectorSlotState): string {
  if (!state.owner) {
    const instance = assembly?.instances.find(i => i.instanceId === state.instanceId);
    const base = instance?.replica
      ? replicaAnchorLabel(assembly, state.instanceName, instance.replica)
      : state.instanceName;
    return `${base}.connectors.${state.connectorName}`;
  }
  const chain = resolveSideChain(assembly, state);
  const via: AssemblyMateViaEntry[] = 'error' in chain ? [] : chain.viaParts ?? [];
  const levels = via.length > 0
    ? via.map(e => ('keys' in e ? renderPartsPath(e.keys) : '.parts.…'))
    : ['.parts.…'];
  const top = topOccurrenceOf(assembly, state.owner);
  const base = top?.replica
    ? replicaAnchorLabel(assembly, top.name, top.replica)
    : (state.ownerLabel ?? state.owner);
  return `${base}${levels.join('')}.connectors.${state.connectorName}`;
}

/** `Cam · main` — prefixed `Gantry › Cam · main` for a sub-assembly pick. */
export function connectorChipLabel(state: ConnectorSlotState): string {
  const scope = state.ownerLabel ? `${state.ownerLabel} › ` : '';
  return `${scope}${state.instanceName} · ${state.connectorName}`;
}

/** `Assembly · hinge` — the assembly's own connector. */
export function worldChipLabel(state: WorldSlotState): string {
  return `Assembly · ${state.connectorName}`;
}

/** `Cam · cylinder` — an exposure named on an instance. */
export function geometryChipLabel(state: GeometrySlotState): string {
  return `${state.instanceName} · ${state.exposeName}`;
}
