import { basename } from 'path';
import { readFile } from 'fs/promises';
import type { FluidCadServer } from './fluidcad-server.ts';
import type { FeatureEditDispatcher } from './edit-dispatch.ts';
import { resolveExportKey } from './assembly-mate-edit.ts';
import type { MateConnectorRef, MateFrameRef, MateGeometryRef } from './assembly-chain-tools.ts';
import { normalizePath } from './normalize-path.ts';

/**
 * The wire forms of statement sides as the mate and replicate dialogs POST
 * them, their body guards, and the occurrence-aware preparation step both
 * routes run before dispatching a transform. Shared so a replicate row cell
 * is addressed exactly like a mate side.
 */

/**
 * One occurrence level of a nested pick's export chain, as the dialog wires
 * it: `keys` when the sub-assembly already exports the next handle (the key
 * path within its return object), `createFrom` when it doesn't — the handle's
 * `insert()` address in its own file, which the route turns into an
 * `assemblyExport` edit (and thereby a key) before writing the statement.
 */
export type MateViaEntryBody =
  | { keys: string[] }
  | { createFrom: { filePath: string; insertLine: number } };

/**
 * The wire form of a connector side: MateConnectorRef with unresolved
 * levels. `replicaRow` addresses a replica: `instanceLine` is then the
 * `replicate()` statement's line and the side lives on its row-th copy.
 */
export type MateConnectorSideBody = {
  instanceLine: number;
  connectorName: string;
  viaParts?: MateViaEntryBody[];
  replicaRow?: number;
};

/** The wire form of an exposure side addressed by name (no raw pick). */
export type NamedGeometrySideBody = MateGeometryRef;

/** Any replicate side as posted: connector, assembly connector, or named exposure. */
export type ReplicateSideBody = MateConnectorSideBody | MateFrameRef | NamedGeometrySideBody;

export function isViaEntry(v: unknown): v is MateViaEntryBody {
  if (v === null || typeof v !== 'object') {
    return false;
  }
  const o = v as any;
  if (Array.isArray(o.keys)) {
    return o.createFrom === undefined && o.keys.every((k: unknown) => typeof k === 'string' && k.length > 0);
  }
  return o.keys === undefined
    && o.createFrom !== null && typeof o.createFrom === 'object'
    && typeof o.createFrom.filePath === 'string' && o.createFrom.filePath.length > 0
    && Number.isInteger(o.createFrom.insertLine) && o.createFrom.insertLine >= 1;
}

function isReplicaRow(v: unknown): boolean {
  return v === undefined || (Number.isInteger(v) && (v as number) >= 0);
}

export function isConnectorRef(v: unknown): v is MateConnectorSideBody {
  return v !== null && typeof v === 'object'
    && Number.isInteger((v as any).instanceLine) && (v as any).instanceLine >= 1
    && typeof (v as any).connectorName === 'string' && (v as any).connectorName.length > 0
    && (v as any).exposeName === undefined
    && isReplicaRow((v as any).replicaRow)
    && ((v as any).viaParts === undefined
      || (Array.isArray((v as any).viaParts) && (v as any).viaParts.every(isViaEntry)));
}

export function isFrameRef(v: unknown): v is MateFrameRef {
  return v !== null && typeof v === 'object'
    && Number.isInteger((v as any).connectorLine) && (v as any).connectorLine >= 1
    && typeof (v as any).connectorName === 'string';
}

export function isNamedGeometryRef(v: unknown): v is NamedGeometrySideBody {
  return v !== null && typeof v === 'object'
    && Number.isInteger((v as any).instanceLine) && (v as any).instanceLine >= 1
    && typeof (v as any).exposeName === 'string' && (v as any).exposeName.length > 0
    && (v as any).connectorName === undefined
    && (v as any).pick === undefined
    && isReplicaRow((v as any).replicaRow);
}

export function isReplicateSide(v: unknown): v is ReplicateSideBody {
  return isConnectorRef(v) || isFrameRef(v) || isNamedGeometryRef(v);
}

export function isPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

export function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

export type PreparedSides<T> = { resolved: T } | { status: number; body: unknown };

/**
 * Occurrence-aware side resolution: a `viaParts` level whose sub-assembly
 * doesn't export the next handle yet (`createFrom`) gets an
 * `assemblyExport` edit dispatched to that file FIRST (§7.2-style
 * sequencing, like cross-file tangent exposures), and the level resolves
 * to the binding key that edit exports. Entries are deduped and processed
 * in descending line order per file so an added `return {...}` line never
 * shifts a later entry's address. A mid-sequence failure names what was
 * and wasn't written — an extra export is inert and reused on retry.
 *
 * Non-connector sides (assembly connectors, named exposures, undefined
 * slots) pass through untouched, so a mixed list of replicate cells
 * prepares in one call.
 */
export function makeSidePreparer(
  fluidCadServer: FluidCadServer,
  dispatcher: FeatureEditDispatcher,
): <S extends ReplicateSideBody | undefined>(sides: S[]) => Promise<PreparedSides<(MateConnectorRef | MateFrameRef | MateGeometryRef | undefined)[]>> {
  return async (sides) => {
    type Pending = { filePath: string; insertLine: number; key?: string };
    const pending = new Map<string, Pending>();
    for (const side of sides) {
      if (!side || !('viaParts' in side)) {
        continue;
      }
      for (const entry of side.viaParts ?? []) {
        if ('createFrom' in entry) {
          const id = `${normalizePath(entry.createFrom.filePath)}:${entry.createFrom.insertLine}`;
          pending.set(id, { ...entry.createFrom });
        }
      }
    }
    const ordered = [...pending.entries()].sort(([, a], [, b]) =>
      a.filePath === b.filePath ? b.insertLine - a.insertLine : a.filePath.localeCompare(b.filePath));
    const written: string[] = [];
    for (const [, task] of ordered) {
      let code: string | null = null;
      if (normalizePath(task.filePath) === normalizePath(fluidCadServer.getCurrentFileName() ?? '')) {
        code = fluidCadServer.getCurrentCode();
      }
      if (code === null) {
        try {
          code = await readFile(task.filePath, 'utf8');
        } catch {
          return { status: 422, body: { success: false, reason: `could not read ${basename(task.filePath)} to export the picked instance` } };
        }
      }
      const key = await resolveExportKey(code, task.insertLine);
      if ('error' in key) {
        return { status: 422, body: { success: false, reason: `${basename(task.filePath)}: ${key.error}` } };
      }
      const sent = await dispatcher.send({
        feature: 'sketch',
        filePath: task.filePath,
        producers: [],
        parts: [],
        imports: [],
        assemblyExport: { insertLine: task.insertLine },
      });
      if (sent.error) {
        const partial = written.length > 0
          ? ` Already exported: ${written.join(', ')} (harmless — an unused export is inert and reused on retry).`
          : '';
        return {
          status: 422,
          body: { success: false, reason: `could not export ${key.name} from ${basename(task.filePath)}: ${sent.error}.${partial}` },
        };
      }
      task.key = key.name;
      written.push(`${key.name} in ${basename(task.filePath)}`);
    }
    const resolved = sides.map((side): MateConnectorRef | MateFrameRef | MateGeometryRef | undefined => {
      if (!side) {
        return undefined;
      }
      if (!('viaParts' in side) || !side.viaParts) {
        return side as MateConnectorRef | MateFrameRef | MateGeometryRef;
      }
      const { viaParts, ...rest } = side as MateConnectorSideBody;
      const resolvedSide: MateConnectorRef = {
        ...rest,
        viaParts: viaParts!.map(entry => 'keys' in entry
          ? entry.keys
          : [pending.get(`${normalizePath(entry.createFrom.filePath)}:${entry.createFrom.insertLine}`)!.key!]),
      };
      return resolvedSide;
    });
    return { resolved };
  };
}
