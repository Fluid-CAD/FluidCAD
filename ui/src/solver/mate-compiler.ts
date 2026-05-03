// Mate dispatcher. One file per mate type adds the right slvs constraints to
// the system; this module just looks the compiler up by mate type and pushes
// the resulting constraint handles into the constraint→mate map so the solver
// can map libslvs' `failed[]` back to mate ids for status-dot rendering.

import type { BodyHandles, ConnectorHandles } from './system-builder.js';
import type { SolveSpaceApi } from './solvespace-loader.js';
import type { MateRecord } from './types.js';
import { compileFastened } from './mates/fastened.js';
import { compileRevolute } from './mates/revolute.js';
import { compileSlider } from './mates/slider.js';
import { compileCylindrical } from './mates/cylindrical.js';
import { compilePlanar } from './mates/planar.js';

export const FREE_IN_3D = 0;

export type CompileCtx = {
  api: SolveSpaceApi;
  sys: any;
  bodies: BodyHandles[];
  /** Allocates the next slvs handle. Shared with system-builder. */
  newH: () => number;
  /** Maps constraint handle → mateId, populated as compilers add constraints. */
  constraintToMate: Map<number, string>;
};

export type MateCompiler = (ctx: CompileCtx, mate: MateRecord) => number[];

export function lookupBody(ctx: CompileCtx, instanceId: string): BodyHandles {
  const body = ctx.bodies.find(b => b.instanceId === instanceId);
  if (!body) {
    throw new Error(`Mate references unknown instance ${instanceId}`);
  }
  return body;
}

export type ConnectorRef = { body: BodyHandles; connector: ConnectorHandles };

export function lookupConnector(
  ctx: CompileCtx,
  instanceId: string,
  connectorId: string,
): ConnectorRef {
  const body = lookupBody(ctx, instanceId);
  const connector = body.connectors.find(c => c.connectorId === connectorId);
  if (!connector) {
    throw new Error(
      `Mate references unknown connector ${connectorId} on ${instanceId}`,
    );
  }
  return { body, connector };
}

const COMPILERS: Record<MateRecord['type'], MateCompiler> = {
  fastened: compileFastened,
  revolute: compileRevolute,
  slider: compileSlider,
  cylindrical: compileCylindrical,
  planar: compilePlanar,
  parallel: notYet('parallel'),
  'pin-slot': notYet('pin-slot'),
};

function notYet(name: string): MateCompiler {
  return () => {
    throw new Error(`mate('${name}') is not implemented yet — phase 07+.`);
  };
}

export function compileMate(ctx: CompileCtx, mate: MateRecord): number[] {
  const compiler = COMPILERS[mate.type];
  if (!compiler) {
    throw new Error(`mate(): unknown mate type "${mate.type}".`);
  }
  const handles = compiler(ctx, mate);
  for (const h of handles) {
    ctx.constraintToMate.set(h, mate.mateId);
  }
  return handles;
}
