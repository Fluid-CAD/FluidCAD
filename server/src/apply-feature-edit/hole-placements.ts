// Hole placements that must be authored before the hole statement renders:
// a sketch point exported through its sketch's return value, and a connector
// created on a picked face or edge inside the part. Both stage against the
// original buffer and hand back one buffer plus the spec that names them —
// the way loft connections stage their exports — so an Apply is one write
// and a refusal never leaves a half-edited file.

import { findEditableCallAt, getJavaScriptParser, splitLines, type TSNode } from '../code-editor/index.ts';
import type { SketchExportRequest } from '../../../lib/dist/selection/sketch-target.js';
import { decomposeChain } from './ast/chain.ts';
import { chainRootCall } from './ast/nodes.ts';
import { stringArgValue } from './ast/args.ts';
import { rootCallsByCallee } from './call-site-relocation.ts';
import type { HolePlacementSpec } from './features/hole.ts';
import { isSketchProducer } from './producers/predicates.ts';
import { SketchExports } from './sketch-exports.ts';
import type { ApplyFeatureEditSpec, FeatureEditApply } from './spec.ts';

type Staged = { code: string; spec: ApplyFeatureEditSpec } | { error: string };

export class HolePlacements {
  /** The placement list a create or an edit spec carries, or undefined. */
  static list(spec: ApplyFeatureEditSpec): HolePlacementSpec[] | undefined {
    return spec.edit ? spec.edit.hole?.placements : spec.hole?.placements;
  }

  static needsStaging(spec: ApplyFeatureEditSpec): boolean {
    const placements = HolePlacements.list(spec);
    return Array.isArray(placements)
      && placements.some(placement => placement?.kind === 'sketch' || placement?.kind === 'newConnector');
  }

  /**
   * Author every staged placement: new connectors first (each a nested
   * connector create, relocating the spec's lines across it), then the
   * sketch exports. The returned spec names each as a `connector` producer
   * or an `expression`.
   */
  static async prepare(code: string, spec: ApplyFeatureEditSpec, apply: FeatureEditApply): Promise<Staged> {
    if (!HolePlacements.needsStaging(spec)) {
      return { code, spec };
    }
    const connectors = await HolePlacements.createConnectors(code, spec, apply);
    if ('error' in connectors) {
      return connectors;
    }
    return HolePlacements.exportSketchPoints(connectors.code, connectors.spec);
  }

  /** The line numbers the spec addresses, in the order `relocate` hands them back. */
  private static trackedLines(spec: ApplyFeatureEditSpec): number[] {
    return [
      ...spec.producers.map(producer => producer.line),
      ...(spec.edit ? [spec.edit.line] : []),
      ...(spec.activePart ? [spec.activePart.line] : []),
    ];
  }

  private static withLines(spec: ApplyFeatureEditSpec, lines: number[], placements: HolePlacementSpec[]): ApplyFeatureEditSpec {
    let at = 0;
    const producers = spec.producers.map(producer => ({ ...producer, line: lines[at++] }));
    const edit = spec.edit
      ? { ...spec.edit, line: lines[at++], hole: { ...spec.edit.hole!, placements } }
      : undefined;
    const activePart = spec.activePart ? { ...spec.activePart, line: lines[at++] } : undefined;
    return {
      ...spec, producers, edit, activePart,
      ...(spec.hole ? { hole: { ...spec.hole, placements } } : {}),
    };
  }

  /**
   * The line numbers a placement addresses in the buffer, in
   * `withPlacementLines` order: a connector still to create names its
   * producers and part; a sketch point names its geometry statement.
   */
  private static placementLines(placement: HolePlacementSpec): number[] {
    if (placement.kind === 'newConnector') {
      return [
        ...placement.create.producers.map(producer => producer.line),
        ...(placement.create.connector?.part ? [placement.create.connector.part.line] : []),
      ];
    }
    if (placement.kind === 'sketch' && placement.target.line !== undefined) {
      return [placement.target.line];
    }
    return [];
  }

  private static withPlacementLines(placement: HolePlacementSpec, lines: number[]): HolePlacementSpec {
    if (placement.kind === 'newConnector') {
      const create = placement.create;
      let at = 0;
      const producers = create.producers.map(producer => ({ ...producer, line: lines[at++] }));
      const connector = create.connector?.part
        ? { ...create.connector, part: { ...create.connector.part, line: lines[at++] } }
        : create.connector;
      return { ...placement, create: { ...create, producers, connector } };
    }
    if (placement.kind === 'sketch' && placement.target.line !== undefined) {
      return { ...placement, target: { ...placement.target, line: lines[0] } };
    }
    return placement;
  }

  private static async createConnectors(code: string, spec: ApplyFeatureEditSpec, apply: FeatureEditApply): Promise<Staged> {
    let working = code;
    let current = spec;
    const placements = [...HolePlacements.list(current)!];
    for (let i = 0; i < placements.length; i++) {
      const placement = placements[i];
      if (placement.kind !== 'newConnector') {
        continue;
      }
      if (await HolePlacements.connectorExists(working, placement.create, placement.name)) {
        return { error: `the part already has a connector named "${placement.name}" — pick a different name` };
      }
      const created = await apply(working, placement.create);
      if (created.error) {
        return { error: created.error };
      }
      const statement = await HolePlacements.findConnector(created.newCode, placement.name);
      if (!statement) {
        return { error: `the connector "${placement.name}" was not written where the hole could find it — re-render and try again` };
      }
      // Every line the spec and its placements address follows the edit —
      // a new import line shifts everything below it, including the
      // connectors still to create and the sketch points still to export.
      const tracked = HolePlacements.trackedLines(current);
      const relocated = await HolePlacements.relocate(working, created.newCode, [
        ...tracked,
        ...placements.flatMap(other => HolePlacements.placementLines(other)),
      ], statement.line);
      if (!relocated) {
        return { error: 'could not relocate the hole\'s inputs after creating its connector — re-render and try again' };
      }
      let at = tracked.length;
      for (let k = 0; k < placements.length; k++) {
        const count = HolePlacements.placementLines(placements[k]).length;
        placements[k] = HolePlacements.withPlacementLines(placements[k], relocated.slice(at, at + count));
        at += count;
      }
      // The new statement binds under the connector's own name, the way a
      // copy names its connector target.
      const producers = [...current.producers, {
        line: statement.line, column: statement.column,
        featureType: 'connector', nameHint: placement.name, bind: true,
      }];
      placements[i] = { kind: 'connector', producer: producers.length - 1 };
      const relocatedSpec = HolePlacements.withLines(current, relocated.slice(0, tracked.length), placements);
      current = { ...relocatedSpec, producers: [...relocatedSpec.producers, producers[producers.length - 1]] };
      working = created.newCode;
    }
    return { code: working, spec: current };
  }

  /**
   * Whether the part receiving the connector already declares `name`. The
   * kernel enforces the same rule at build time; refusing here keeps the
   * file from taking a statement that would fail to render.
   */
  private static async connectorExists(code: string, create: ApplyFeatureEditSpec, name: string): Promise<boolean> {
    const partLine = create.connector?.part?.line;
    if (!partLine) {
      return false;
    }
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const partCall = findEditableCallAt(tree, splitLines(code), partLine);
    const part = partCall ? chainRootCall(partCall) : null;
    if (!part) {
      return false;
    }
    for (const call of rootCallsByCallee(tree).get('connector') ?? []) {
      const inside = call.startIndex >= part.startIndex && call.endIndex <= part.endIndex;
      if (inside && HolePlacements.connectorName(call) === name) {
        return true;
      }
    }
    return false;
  }

  private static connectorName(call: TSNode): string | null {
    const chain = decomposeChain(call);
    const nameArg = chain?.root.args[0];
    return nameArg ? stringArgValue(nameArg) : null;
  }

  /** The `connector('<name>', …)` call the nested create wrote, by name. */
  private static async findConnector(code: string, name: string): Promise<{ line: number; column: number } | null> {
    const parser = await getJavaScriptParser();
    const calls = rootCallsByCallee(parser.parse(code)).get('connector') ?? [];
    const match = calls.filter(call => HolePlacements.connectorName(call) === name);
    if (match.length !== 1) {
      return null;
    }
    return { line: match[0].startPosition.row + 1, column: match[0].startPosition.column };
  }

  /**
   * Follow the spec's lines across the connector create. The generic
   * relocation refuses when a callee's call count changed — which the new
   * `connector()` does — so the new statement is set aside before the
   * ordinals are matched.
   */
  private static async relocate(before: string, after: string, lines: number[], createdLine: number): Promise<number[] | null> {
    const parser = await getJavaScriptParser();
    const treeBefore = parser.parse(before);
    const linesBefore = splitLines(before);
    const callsBefore = rootCallsByCallee(treeBefore);
    const callsAfter = rootCallsByCallee(parser.parse(after));
    const out: number[] = [];
    for (const line of lines) {
      const call = findEditableCallAt(treeBefore, linesBefore, line);
      const root = call ? chainRootCall(call) : null;
      const callee = root?.childForFieldName('function')?.text ?? null;
      if (!root || callee === null) {
        return null;
      }
      const ordinal = (callsBefore.get(callee) ?? []).findIndex(c => c.startIndex === root.startIndex);
      const candidates = (callsAfter.get(callee) ?? []).filter(c => c.startPosition.row + 1 !== createdLine || callee !== 'connector');
      if (ordinal < 0 || candidates.length !== (callsBefore.get(callee) ?? []).length) {
        return null;
      }
      out.push(candidates[ordinal].startPosition.row + 1);
    }
    return out;
  }

  private static async exportSketchPoints(code: string, spec: ApplyFeatureEditSpec): Promise<Staged> {
    const placements = HolePlacements.list(spec)!;
    const refs: SketchExportRequest[] = [];
    for (const placement of placements) {
      if (placement.kind !== 'sketch') {
        continue;
      }
      if (!isSketchProducer(spec, placement.producer)) {
        return { error: 'a hole placement on a sketch point needs its sketch producer' };
      }
      const producer = spec.producers[placement.producer];
      refs.push({ sketch: { filePath: spec.filePath, line: producer.line, column: producer.column }, target: placement.target });
    }
    if (refs.length === 0) {
      return { code, spec };
    }
    const staged = await SketchExports.applyCreates(code, refs, HolePlacements.trackedLines(spec));
    if ('error' in staged) {
      return staged;
    }
    let expression = 0;
    const renamed = placements.map(placement => placement.kind === 'sketch'
      ? { kind: 'expression' as const, expression: staged.expressions[expression++] }
      : placement);
    return { code: staged.code, spec: HolePlacements.withLines(spec, staged.anchors, renamed) };
  }
}
