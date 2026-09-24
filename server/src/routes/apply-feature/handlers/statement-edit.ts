// POST /apply-feature, in-place statement edit: re-parse the statement, apply the dialog options, re-render.

import type { Request, Response } from 'express';
import {
  enclosingSketchLine,
  extractNumericParams,
  LoftConnections,
  makeProducerNamer,
  parseFeatureStatement,
  renderEditedStatement,
  resolveEditedStatementLine,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type ConnectorAnchorSpec,
  type FeatureStatementEditTarget,
  type RepeatEditAxis,
  type RotateEditAxis,
  type ValueExpr,
} from '../../../apply-feature-edit/index.ts';
import { normalizePath } from '../../../normalize-path.ts';
import type { SketchLoc } from '../locations.ts';
import { validateBoundary, type Pick } from '../picks.ts';
import { allocateProducerVars, makeProducerMerger } from '../synthesis.ts';
import type { CopyEditAxisInput } from '../validate/copy.ts';
import { loftProfileOwners, synthesizeLoftConnections } from '../validate/loft.ts';
import { projectSketchRefusal } from '../validate/project.ts';
import type { RepeatEditAxisInput } from '../validate/repeat.ts';
import { validateStatementEdit } from '../validate/statement-edit.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// In-place statement edit (timeline double-click → edit dialog): the
// statement at the location is re-parsed from the live buffer and its
// dialog options replaced. Re-sourced slots (re-picked selections,
// profiles, paths) synthesize selectors against the scene truncated to
// the `before` boundary — the world the statement's arguments see.
export async function handleStatementEdit(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, foreignPicks, preview, newVariables } = ctx;
  const request = validateStatementEdit(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  const before = validateBoundary(req.body?.before);
  if (before === null) {
    res.status(400).json({ error: 'before must be {index, type, line, column}' });
    return;
  }
  // The sketch retarget is the exception: its pick was made against the
  // CURRENT full render (sketch editing merely suspended, no rollback),
  // so synthesis runs boundary-less against that same scene.
  if (request.needsPicks && !before && request.feature !== 'sketch') {
    res.status(400).json({ error: 'before is required when an edit re-picks geometry' });
    return;
  }
  try {
    // The transform edits the live buffer's file only.
    const currentFile = fluidCadServer.getCurrentFileName();
    if (currentFile && normalizePath(request.target.filePath) !== normalizePath(currentFile)) {
      res.status(422).json({ success: false, reason: 'that feature lives in a different file than the one being edited' });
      return;
    }
    const sketchLocs: SketchLoc[] = [
      ...(request.extrudeProfile ? [request.extrudeProfile] : []),
      ...(request.ribSpine ? [request.ribSpine] : []),
      ...(request.scope ?? []).flatMap(t => t.kind === 'feature' ? [t.loc] : []),
      ...(request.sweepPath?.kind === 'sketch' ? [request.sweepPath] : []),
      ...(request.sweepProfile ? [request.sweepProfile] : []),
      ...(request.wrapSketch ? [request.wrapSketch] : []),
      ...(request.revolveProfile ? [request.revolveProfile] : []),
      ...(request.revolveAxis?.kind === 'axis' ? [request.revolveAxis.loc] : []),
      ...(request.helixSource?.kind === 'axis' ? [request.helixSource.loc] : []),
      ...(request.loftProfiles ?? []).filter((p): p is { kind: 'sketch' } & SketchLoc => p.kind === 'sketch'),
      ...(request.loftGuides ?? []).filter((g): g is { kind: 'sketch' } & SketchLoc => g.kind === 'sketch'),
      ...(request.sketchTarget?.kind === 'planeRef' ? [request.sketchTarget.loc] : []),
      ...(request.repeatDirections ?? []).flatMap(d => d.axis.kind === 'axis' ? [d.axis.loc] : []),
      ...(request.repeatAxis?.kind === 'axis' ? [request.repeatAxis.loc] : []),
      ...(request.repeatPlane?.kind === 'plane' ? [request.repeatPlane.loc] : []),
      ...(request.repeatTargets ?? []).flatMap(t => t.kind === 'feature' ? [t.loc] : []),
      ...(request.copyDirections ?? []).flatMap(d => d.axis.kind === 'axis' ? [d.axis.loc] : []),
      ...(request.copyAxis?.kind === 'axis' ? [request.copyAxis.loc] : []),
      ...(request.copyTargets ?? []).flatMap(t => t.kind === 'feature' ? [t.loc] : []),
      ...(request.mirrorPlane?.kind === 'plane' ? [request.mirrorPlane.loc] : []),
      ...(request.mirrorTargets ?? []).flatMap(t => t.kind === 'feature' ? [t.loc] : []),
      ...(request.rotateAxis?.kind === 'axis' ? [request.rotateAxis.loc] : []),
      ...(request.rotateTargets ?? []).flatMap(t => t.kind === 'feature' ? [t.loc] : []),
      ...(request.booleanTargets ?? []).flatMap(t => t.kind === 'feature' ? [t.loc] : []),
      ...(request.planeBases ?? []).flatMap(b => b.kind === 'plane' || b.kind === 'wire' ? [b.loc] : []),
    ];
    for (const loc of sketchLocs) {
      if (normalizePath(loc.filePath) !== normalizePath(request.target.filePath)) {
        res.status(422).json({ success: false, reason: 'a re-sourced input lives in a different file than the edited statement' });
        return;
      }
    }

    const code = fluidCadServer.getCurrentCode();
    if (code) {
      // The 2D offset's edit pause sits ABOVE its own statement, which
      // shifts the statement down after the dialog captured its line —
      // re-locate it before the preview parse and the transform spec read
      // a stale line. Inert for the 3D edits, whose pause sits below.
      request.edit.line = await resolveEditedStatementLine(
        code, request.edit.line, request.edit.expectedStatement,
      );
    }
    const { producers, merge: mergeProducer } = makeProducerMerger();
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const importSet = new Set<string>();
    let synthesizedArgs: string | undefined;
    let alternatives: string[] = [];
    let rawArgs = request.rawArgs;

    let synthOptions: {
      namer?: Awaited<ReturnType<typeof makeProducerNamer>>;
      params?: { name: string; value: number }[];
    } | undefined;
    if ((request.needsPicks || request.sketchPicks || request.copySketchTargets
      || request.copyAxisPicks) && code) {
      synthOptions = {
        namer: await makeProducerNamer(code),
        params: resolveParamValues(
          await extractNumericParams(code),
          fluidCadServer.getParamDefinitions(),
        ),
      };
    }

    /** Synthesize one re-picked slot against the pre-statement scene. */
    const synthesizeSlot = (
      picks: Pick[],
      kind: 'extrude' | 'sweep' | 'loft' | 'revolve' | 'fillet' | 'chamfer' | 'shell' | 'wrap' | 'sketch' | 'plane' | 'helix' | 'project' | 'offset' | 'connector',
      value: ValueExpr | undefined,
      chains: { seed: Pick; members: Pick[] }[],
      extra?: { connector?: { anchor?: ConnectorAnchorSpec } },
    ): any | null => {
      const synthesis = fluidCadServer.synthesizeApplyFeature(
        picks, kind, value, chains, { ...synthOptions, ...extra }, before,
      );
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return null;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return null;
      }
      return synthesis;
    };
    /** Fold one synthesis result's producers/parts/imports into the spec. */
    const foldSynthesis = (synthesis: any): number => {
      const remap = synthesis.spec.producers.map(mergeProducer);
      for (const part of synthesis.spec.parts) {
        parts.push({
          ...part,
          producer: part.producer === null ? null : remap[part.producer],
          refs: part.refs ? part.refs.map((i: number) => remap[i]) : part.refs,
        });
      }
      for (const symbol of synthesis.spec.imports) {
        importSet.add(symbol);
      }
      return parts.length - synthesis.spec.parts.length;
    };
    const sketchRef = (loc: SketchLoc, nameHint: string): number => mergeProducer({
      line: loc.line, column: loc.column, featureType: 'sketch', nameHint, bind: true,
    });
    // A wire slot (a sweep path, a loft guide) takes a sketch() or a
    // helix() statement.
    const wireRef = (loc: SketchLoc, nameHint: string): number => mergeProducer({
      line: loc.line, column: loc.column, featureType: 'wire', nameHint, bind: true,
    });

    const edit = request.edit;
    if (request.extrudeProfile) {
      // An offset profile binds under its own callee guard and hint.
      const producer = request.extrudeProfile.feature === 'offset'
        ? mergeProducer({
          line: request.extrudeProfile.line, column: request.extrudeProfile.column,
          featureType: 'offset', nameHint: 'o', bind: true,
        })
        : sketchRef(request.extrudeProfile, 's');
      edit.extrude!.profile = { kind: 'sketch', producer };
      edit.extrude!.regionSketch = { line: request.extrudeProfile.line, column: request.extrudeProfile.column };
    }
    if (request.extrudeToFace) {
      const synthesis = synthesizeSlot([request.extrudeToFace], 'extrude', undefined, []);
      if (!synthesis) {
        return;
      }
      // The target argument is ONE SceneObject — a multi-part selection
      // has no single-expression rendering.
      if (synthesis.spec.parts.length !== 1) {
        res.status(422).json({ success: false, reason: 'the extrude target must be a single face selection' });
        return;
      }
      foldSynthesis(synthesis);
      edit.extrude!.toFace = { kind: 'selector' };
    }
    if (request.ribSpine) {
      edit.rib!.spine = { kind: 'sketch', producer: sketchRef(request.ribSpine, 's') };
    }
    if (request.scope) {
      // The full replacement `.scope(…)` list — keeps stay text-addressed
      // by their position in the statement, re-picked solids bind feature
      // producers. One list shape for every dialog that writes the chain;
      // it lands on whichever feature this edit carries.
      const scopeTargets = request.scope.map(target => target.kind === 'verbatim'
        ? { kind: 'verbatim' as const, sourceIndex: target.sourceIndex }
        : {
          kind: 'feature' as const,
          producer: mergeProducer({
            line: target.loc.line, column: target.loc.column,
            featureType: 'feature', nameHint: 'f', bind: true,
          }),
        });
      const scoped = edit.rib ?? edit.extrude ?? edit.sweep ?? edit.loft ?? edit.revolve;
      if (scoped) {
        scoped.scope = scopeTargets;
      }
    }
    if (request.sweepPath) {
      if (request.sweepPath.kind === 'sketch') {
        edit.sweep!.path = { kind: 'sketch', producer: wireRef(request.sweepPath, 'p') };
      } else {
        const synthesis = synthesizeSlot(
          request.sweepPath.picks, 'sweep', undefined, request.sweepPath.chains,
        );
        if (!synthesis) {
          return;
        }
        // The path argument is ONE SceneObject — a multi-part selection
        // has no single-expression rendering.
        if (synthesis.spec.parts.length !== 1) {
          res.status(422).json({
            success: false,
            reason: 'the picked edges must form a single selection — use "Select with tangents" or pick edges of one feature',
          });
          return;
        }
        foldSynthesis(synthesis);
        edit.sweep!.path = { kind: 'selector' };
      }
    }
    if (request.sweepProfile) {
      edit.sweep!.profile = { kind: 'sketch', producer: sketchRef(request.sweepProfile, 's') };
      edit.sweep!.regionSketch = { line: request.sweepProfile.line, column: request.sweepProfile.column };
    }
    if (request.wrapSketch) {
      edit.wrap!.sketch = { kind: 'sketch', producer: sketchRef(request.wrapSketch, 's') };
      edit.wrap!.regionSketch = { line: request.wrapSketch.line, column: request.wrapSketch.column };
    }
    if (request.wrapFace) {
      const synthesis = synthesizeSlot([request.wrapFace], 'wrap', undefined, []);
      if (!synthesis) {
        return;
      }
      // The target argument is ONE SceneObject — a multi-part selection
      // has no single-expression rendering.
      if (synthesis.spec.parts.length !== 1) {
        res.status(422).json({ success: false, reason: 'the wrap target must be a single face selection' });
        return;
      }
      foldSynthesis(synthesis);
      edit.wrap!.face = { kind: 'selector' };
    }
    if (request.revolveProfile) {
      edit.revolve!.profile = { kind: 'sketch', producer: sketchRef(request.revolveProfile, 's') };
      edit.revolve!.regionSketch = { line: request.revolveProfile.line, column: request.revolveProfile.column };
    }
    if (request.revolveAxis) {
      if (request.revolveAxis.kind === 'standard') {
        edit.revolve!.axis = { kind: 'standard', axis: request.revolveAxis.axis };
      } else if (request.revolveAxis.kind === 'axis') {
        edit.revolve!.axis = {
          kind: 'axis',
          producer: mergeProducer({
            line: request.revolveAxis.loc.line, column: request.revolveAxis.loc.column,
            featureType: 'axis', nameHint: 'a', bind: true,
          }),
        };
      } else {
        const synthesis = synthesizeSlot([request.revolveAxis.pick], 'revolve', undefined, []);
        if (!synthesis) {
          return;
        }
        // The axis argument is ONE SceneObject — a multi-part selection
        // has no single-expression rendering.
        if (synthesis.spec.parts.length !== 1) {
          res.status(422).json({ success: false, reason: 'the revolve axis must be a single edge selection' });
          return;
        }
        foldSynthesis(synthesis);
        importSet.add('axis');
        edit.revolve!.axis = { kind: 'selector' };
      }
    }
    if (request.helixSource) {
      if (request.helixSource.kind === 'standard') {
        edit.helix!.source = { kind: 'standard', axis: request.helixSource.axis };
      } else if (request.helixSource.kind === 'axis') {
        edit.helix!.source = {
          kind: 'axis',
          producer: mergeProducer({
            line: request.helixSource.loc.line, column: request.helixSource.loc.column,
            featureType: 'axis', nameHint: 'a', bind: true,
          }),
        };
      } else {
        const synthesis = synthesizeSlot([request.helixSource.pick], 'helix', undefined, []);
        if (!synthesis) {
          return;
        }
        // The source argument is ONE SceneObject — a multi-part selection
        // has no single-expression rendering.
        if (synthesis.spec.parts.length !== 1) {
          res.status(422).json({ success: false, reason: 'the helix source must be a single edge or face selection' });
          return;
        }
        foldSynthesis(synthesis);
        if (request.helixSource.kind === 'edge') {
          importSet.add('axis');
        }
        edit.helix!.source = { kind: request.helixSource.kind };
      }
    }
    if (request.loftProfiles) {
      const profiles: NonNullable<FeatureStatementEditTarget['loft']>['profiles'] = [];
      for (const profile of request.loftProfiles) {
        if (profile.kind === 'verbatim') {
          profiles.push({ kind: 'verbatim', sourceIndex: profile.sourceIndex });
          continue;
        }
        if (profile.kind === 'sketch') {
          profiles.push({ kind: 'sketch', producer: sketchRef(profile, 's') });
          continue;
        }
        // Face picks synthesize ONE AT A TIME — the kernel groups picks
        // by (producer, bucket), and a batched call would merge
        // same-bucket faces into one part, destroying order and arity.
        const synthesis = synthesizeSlot([profile.pick], 'loft', undefined, []);
        if (!synthesis) {
          return;
        }
        if (synthesis.spec.parts.length !== 1) {
          res.status(422).json({ success: false, reason: 'a loft profile must be a single face selection' });
          return;
        }
        const firstPart = foldSynthesis(synthesis);
        profiles.push({ kind: 'selector', part: firstPart });
      }
      edit.loft!.profiles = profiles;
    }
    if (request.loftGuides) {
      edit.loft!.guides = request.loftGuides.map(guide => guide.kind === 'verbatim'
        ? { kind: 'verbatim' as const, sourceIndex: guide.sourceIndex }
        : { kind: 'sketch' as const, producer: wireRef(guide, 'g') });
    }
    if (request.loftConnections !== undefined) {
      const connections = await synthesizeLoftConnections(fluidCadServer, request.loftConnections,
        request.target.filePath, mergeProducer, request.target,
        loftProfileOwners(request.loftProfiles), before ?? undefined);
      if ('error' in connections) {
        res.status(422).json({ success: false, reason: connections.error });
        return;
      }
      edit.loft!.connections = connections.connections;
      for (const symbol of connections.imports) {
        importSet.add(symbol);
      }
    }
    if (request.sketchTarget) {
      const target = request.sketchTarget;
      if (target.kind === 'standard') {
        edit.sketch!.target = { kind: 'standard', plane: target.plane };
      } else if (target.kind === 'planeRef') {
        edit.sketch!.target = {
          kind: 'plane',
          producer: mergeProducer({
            line: target.loc.line, column: target.loc.column,
            featureType: 'plane', nameHint: 'p', bind: true,
          }),
        };
      } else {
        const synthesis = synthesizeSlot([target.pick], 'sketch', undefined, []);
        if (!synthesis) {
          return;
        }
        // The target argument is ONE SceneObject — a multi-part selection
        // has no single-expression rendering.
        if (synthesis.spec.parts.length !== 1) {
          res.status(422).json({ success: false, reason: 'the sketch target must be a single face selection' });
          return;
        }
        foldSynthesis(synthesis);
        edit.sketch!.target = { kind: 'selector' };
      }
    }
    if (request.projectSketches && request.feature === 'project') {
      // The re-sourced sketches obey the create path's rules: same file,
      // same part, and never the sketch the statement is drawn in.
      const consumer = fluidCadServer.resolveStatementPart?.(request.target) ?? null;
      const receiverLine = code ? await enclosingSketchLine(code, request.edit.line) : null;
      const receiver = { ...request.target, line: receiverLine ?? -1 };
      for (const loc of request.projectSketches) {
        const refusal = projectSketchRefusal(
          loc, receiver, consumer, fluidCadServer.resolveStatementPart?.bind(fluidCadServer),
        );
        if (refusal) {
          res.status(422).json({ success: false, reason: refusal });
          return;
        }
      }
    }
    if (request.picks && request.picks.length > 0 && request.feature === 'project') {
      // Re-sourcing keeps the statement in place, so its arguments must
      // stay the statement's own part's geometry: another part's pick
      // would need the find-or-create reference rail the create path
      // runs, which the in-place rewrite does not carry.
      const consumer = fluidCadServer.resolveStatementPart?.(request.target) ?? null;
      const owners = consumer ? await foreignPicks.classify(request.picks, consumer) : { ok: true as const, foreign: [] };
      if (owners.ok === false) {
        res.status(422).json({ success: false, reason: owners.reason, pick: owners.pick });
        return;
      }
      if (owners.foreign.length > 0) {
        const names = [...new Set(owners.foreign.map(f => f.donor.partName))].map(n => `"${n}"`).join(', ');
        res.status(422).json({
          success: false,
          reason: `the re-picked geometry belongs to another part (${names}) — an existing projection keeps `
            + 'its own part\'s sources; add a new Project or Intersect for geometry from another part',
          pick: owners.foreign[0].pick,
        });
        return;
      }
    }
    if (request.picks && request.picks.length > 0) {
      // A connector's name rides the value channel, and its anchor rides
      // the options — the synthesis renders the suffix onto the args, so
      // the re-picked source reads exactly like a freshly created one.
      const synthesis = synthesizeSlot(
        request.picks,
        request.feature as 'fillet' | 'chamfer' | 'shell' | 'project' | 'offset' | 'connector',
        request.feature === 'connector' ? edit.connector!.name : request.value,
        request.chains ?? [],
        request.feature === 'connector' ? { connector: { anchor: request.connectorAnchor } } : undefined,
      );
      if (!synthesis) {
        return;
      }
      foldSynthesis(synthesis);
      synthesizedArgs = synthesis.args;
      alternatives = synthesis.alternatives;
      // The user's expression text wins only when it differs from what
      // the picks synthesize — the create path's contract.
      rawArgs = rawArgs !== undefined && rawArgs !== synthesis.args ? rawArgs : undefined;
    }
    if (request.feature === 'repeat') {
      const rp = edit.repeat!;
      // One repeat axis input as its edit spec form; null after refusing.
      // Keeps and standard axes pass through; an axis statement binds a
      // producer; a picked edge synthesizes its own selector part against
      // the pre-statement boundary, wrapped in `axis(…)` at render time.
      const resolveAxis = (input: RepeatEditAxisInput): RepeatEditAxis | null => {
        if (input.kind === 'keep') {
          return { kind: 'keep', sourceIndex: input.sourceIndex };
        }
        if (input.kind === 'standard') {
          return { kind: 'standard', axis: input.axis };
        }
        if (input.kind === 'axis') {
          return {
            kind: 'axis',
            producer: mergeProducer({
              line: input.loc.line, column: input.loc.column,
              featureType: 'axis', nameHint: 'a', bind: true,
            }),
          };
        }
        const synthesis = synthesizeSlot([input.pick], 'revolve', undefined, []);
        if (!synthesis) {
          return null;
        }
        // The axis argument is ONE SceneObject — a multi-part selection
        // has no single-expression rendering.
        if (synthesis.spec.parts.length !== 1) {
          res.status(422).json({ success: false, reason: 'a repeat axis must be a single edge selection' });
          return null;
        }
        const part = foldSynthesis(synthesis);
        importSet.add('axis');
        return { kind: 'selector', part };
      };
      if (request.repeatDirections) {
        const directions: NonNullable<typeof rp.directions> = [];
        for (const direction of request.repeatDirections) {
          const axis = resolveAxis(direction.axis);
          if (axis === null) {
            return;
          }
          directions.push({ axis, count: direction.count, value: direction.value });
        }
        rp.directions = directions;
      }
      if (request.repeatAxis) {
        const axis = resolveAxis(request.repeatAxis);
        if (axis === null) {
          return;
        }
        rp.axis = axis;
      }
      if (request.repeatPlane) {
        const input = request.repeatPlane;
        if (input.kind === 'keep') {
          rp.plane = { kind: 'keep' };
        } else if (input.kind === 'standard') {
          rp.plane = { kind: 'standard', plane: input.plane };
        } else if (input.kind === 'plane') {
          rp.plane = {
            kind: 'plane',
            producer: mergeProducer({
              line: input.loc.line, column: input.loc.column,
              featureType: 'plane', nameHint: 'p', bind: true,
            }),
          };
        } else {
          const synthesis = synthesizeSlot([input.pick], 'plane', undefined, []);
          if (!synthesis) {
            return;
          }
          // The plane argument is ONE SceneObject — a multi-part
          // selection has no single-expression rendering.
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({ success: false, reason: 'the mirror plane must be a single face selection' });
            return;
          }
          const part = foldSynthesis(synthesis);
          importSet.add('plane');
          rp.plane = { kind: 'selector', part };
        }
      }
      if (request.repeatTargets) {
        rp.targets = request.repeatTargets.map(target => target.kind === 'verbatim'
          ? { kind: 'verbatim' as const, sourceIndex: target.sourceIndex }
          : {
            kind: 'feature' as const,
            producer: mergeProducer({
              line: target.loc.line, column: target.loc.column,
              featureType: 'feature', nameHint: 'f', bind: true,
            }),
          });
      }
    }
    if (request.feature === 'copy') {
      const cp = edit.copy!;
      // 2D re-picks (sketch targets and/or axis edges) resolve through
      // the sketch synthesis kernel against the CURRENT scene — the
      // double-click paused the build just before the statement, so the
      // rendered sketch already is the world the arguments see.
      let sketchTargetProducers: number[] | null = null;
      const sketchAxisParts: number[] = [];
      if (request.copySketchTargets || (request.copyAxisPicks?.length ?? 0) > 0) {
        const synthesis = fluidCadServer.synthesizeSketchApplyFeature(
          request.copySketchTargets ?? [], 'copy', undefined,
          { ...synthOptions, axisRefs: request.copyAxisPicks ?? [] },
        );
        if (!synthesis) {
          res.status(404).json({ success: false, reason: 'No rendered scene' });
          return;
        }
        if (!synthesis.ok) {
          res.status(422).json({ success: false, reason: synthesis.reason });
          return;
        }
        if (!synthesis.copySlots) {
          res.status(422).json({
            success: false,
            reason: "the workspace's FluidCAD version does not support the 2D copy dialog — update its fluidcad dependency",
          });
          return;
        }
        const remap = synthesis.spec.producers.map(mergeProducer);
        for (const part of synthesis.spec.parts) {
          parts.push({
            ...part,
            producer: part.producer === null ? null : remap[part.producer],
            refs: part.refs ? part.refs.map((i: number) => remap[i]) : part.refs,
          });
          sketchAxisParts.push(parts.length - 1);
        }
        if (request.copySketchTargets) {
          sketchTargetProducers = synthesis.copySlots.targets.map((i: number) => remap[i]);
        }
      }
      let sketchAxisIndex = 0;
      // One copy axis input as its edit spec form; null after refusing.
      // Keeps, standard and sketch-plane (xAxis()/yAxis()) axes pass
      // through; an axis statement
      // binds a producer; a picked 3D edge synthesizes its own selector
      // part against the pre-statement boundary; a picked sketch edge
      // claims the next kernel-synthesized part. Both render wrapped in
      // `axis(…)`.
      const resolveAxis = (input: CopyEditAxisInput): RepeatEditAxis | null => {
        if (input.kind === 'keep') {
          return { kind: 'keep', sourceIndex: input.sourceIndex };
        }
        if (input.kind === 'standard') {
          return { kind: 'standard', axis: input.axis };
        }
        if (input.kind === 'local') {
          importSet.add(`${input.axis}Axis`);
          return { kind: 'local', axis: input.axis };
        }
        if (input.kind === 'sketch-edge') {
          importSet.add('axis');
          return { kind: 'selector', part: sketchAxisParts[sketchAxisIndex++] };
        }
        if (input.kind === 'axis') {
          return {
            kind: 'axis',
            producer: mergeProducer({
              line: input.loc.line, column: input.loc.column,
              featureType: 'axis', nameHint: 'a', bind: true,
            }),
          };
        }
        const synthesis = synthesizeSlot([input.pick], 'revolve', undefined, []);
        if (!synthesis) {
          return null;
        }
        // The axis argument is ONE SceneObject — a multi-part selection
        // has no single-expression rendering.
        if (synthesis.spec.parts.length !== 1) {
          res.status(422).json({ success: false, reason: 'a copy axis must be a single edge selection' });
          return null;
        }
        const part = foldSynthesis(synthesis);
        importSet.add('axis');
        return { kind: 'selector', part };
      };
      if (request.copyDirections) {
        const directions: NonNullable<typeof cp.directions> = [];
        for (const direction of request.copyDirections) {
          const axis = resolveAxis(direction.axis);
          if (axis === null) {
            return;
          }
          directions.push({ axis, count: direction.count, value: direction.value });
        }
        cp.directions = directions;
      }
      if (request.copyAxis) {
        const axis = resolveAxis(request.copyAxis);
        if (axis === null) {
          return;
        }
        cp.axis = axis;
      }
      if (sketchTargetProducers) {
        // The 2D re-pick replaces the whole target list, in pick order.
        cp.targets = sketchTargetProducers.map(producer => ({ kind: 'feature' as const, producer }));
      } else if (request.copyTargets) {
        cp.targets = request.copyTargets.map(target => target.kind === 'verbatim'
          ? { kind: 'verbatim' as const, sourceIndex: target.sourceIndex }
          : {
            kind: 'feature' as const,
            producer: mergeProducer({
              line: target.loc.line, column: target.loc.column,
              featureType: 'feature', nameHint: 'f', bind: true,
            }),
          });
      }
    }
    if (request.feature === 'mirror') {
      const mo = edit.mirror!;
      // The 2D in-sketch form: re-picked targets and/or the mirror line
      // resolve through the sketch synthesis kernel against the CURRENT
      // scene — the double-click paused the build just before the
      // statement, so the rendered sketch already is the world the
      // arguments see. A picked line claims the kernel-synthesized part,
      // rendered bare; a datum axis renders `xAxis()` / `yAxis()`.
      if (request.mirrorAxis) {
        let sketchTargetProducers: number[] | null = null;
        let sketchAxisPart: number | null = null;
        if (request.mirrorSketchTargets || (request.mirrorAxisPicks?.length ?? 0) > 0) {
          const synthesis = fluidCadServer.synthesizeSketchApplyFeature(
            request.mirrorSketchTargets ?? [], 'mirror', undefined,
            { ...synthOptions, axisRefs: request.mirrorAxisPicks ?? [] },
          );
          if (!synthesis) {
            res.status(404).json({ success: false, reason: 'No rendered scene' });
            return;
          }
          if (!synthesis.ok) {
            res.status(422).json({ success: false, reason: synthesis.reason });
            return;
          }
          if (!synthesis.copySlots) {
            res.status(422).json({
              success: false,
              reason: "the workspace's FluidCAD version does not support the 2D mirror dialog — update its fluidcad dependency",
            });
            return;
          }
          const remap = synthesis.spec.producers.map(mergeProducer);
          for (const part of synthesis.spec.parts) {
            parts.push({
              ...part,
              producer: part.producer === null ? null : remap[part.producer],
              refs: part.refs ? part.refs.map((i: number) => remap[i]) : part.refs,
            });
            sketchAxisPart = parts.length - 1;
          }
          if (request.mirrorSketchTargets) {
            sketchTargetProducers = synthesis.copySlots.targets.map((i: number) => remap[i]);
          }
        }
        const input = request.mirrorAxis;
        if (input.kind === 'keep') {
          mo.axis = { kind: 'keep' };
        } else if (input.kind === 'local') {
          importSet.add(`${input.axis}Axis`);
          mo.axis = { kind: 'local', axis: input.axis };
        } else {
          if (sketchAxisPart === null) {
            res.status(422).json({ success: false, reason: 'the mirror line pick did not resolve to a sketch line' });
            return;
          }
          mo.axis = { kind: 'selector', part: sketchAxisPart };
        }
        if (sketchTargetProducers) {
          // The 2D re-pick replaces the whole target list, in pick order.
          mo.targets = sketchTargetProducers.map(producer => ({ kind: 'feature' as const, producer }));
        }
      }
      if (request.mirrorPlane) {
        const input = request.mirrorPlane;
        if (input.kind === 'keep') {
          mo.plane = { kind: 'keep' };
        } else if (input.kind === 'standard') {
          mo.plane = { kind: 'standard', plane: input.plane };
        } else if (input.kind === 'plane') {
          mo.plane = {
            kind: 'plane',
            producer: mergeProducer({
              line: input.loc.line, column: input.loc.column,
              featureType: 'plane', nameHint: 'p', bind: true,
            }),
          };
        } else {
          const synthesis = synthesizeSlot([input.pick], 'plane', undefined, []);
          if (!synthesis) {
            return;
          }
          // The plane argument is ONE SceneObject — a multi-part
          // selection has no single-expression rendering.
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({ success: false, reason: 'the mirror plane must be a single face selection' });
            return;
          }
          const part = foldSynthesis(synthesis);
          importSet.add('plane');
          mo.plane = { kind: 'selector', part };
        }
      }
      if (request.mirrorTargets) {
        mo.targets = request.mirrorTargets.map(target => target.kind === 'verbatim'
          ? { kind: 'verbatim' as const, sourceIndex: target.sourceIndex }
          : {
            kind: 'feature' as const,
            producer: mergeProducer({
              line: target.loc.line, column: target.loc.column,
              featureType: 'feature', nameHint: 'f', bind: true,
            }),
          });
      }
    }
    if (request.feature === 'rotate') {
      const ro = edit.rotate!;
      if (request.rotateAxis) {
        const input = request.rotateAxis;
        let axis: RotateEditAxis | null;
        if (input.kind === 'keep') {
          axis = { kind: 'keep' };
        } else if (input.kind === 'standard') {
          axis = { kind: 'standard', axis: input.axis };
        } else if (input.kind === 'axis') {
          axis = {
            kind: 'axis',
            producer: mergeProducer({
              line: input.loc.line, column: input.loc.column,
              featureType: 'axis', nameHint: 'a', bind: true,
            }),
          };
        } else {
          const synthesis = synthesizeSlot([input.pick], 'revolve', undefined, []);
          if (!synthesis) {
            return;
          }
          // The axis argument is ONE SceneObject — a multi-part
          // selection has no single-expression rendering.
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({ success: false, reason: 'a rotate axis must be a single edge selection' });
            return;
          }
          const part = foldSynthesis(synthesis);
          importSet.add('axis');
          axis = { kind: 'selector', part };
        }
        ro.axis = axis;
      }
      if (request.rotateTargets) {
        ro.targets = request.rotateTargets.map(target => target.kind === 'verbatim'
          ? { kind: 'verbatim' as const, sourceIndex: target.sourceIndex }
          : {
            kind: 'feature' as const,
            producer: mergeProducer({
              line: target.loc.line, column: target.loc.column,
              featureType: 'feature', nameHint: 'f', bind: true,
            }),
          });
      }
    }
    if (request.feature === 'plane' && request.planeBases) {
      const bases: NonNullable<NonNullable<FeatureStatementEditTarget['plane']>['bases']> = [];
      for (const input of request.planeBases) {
        if (input.kind === 'verbatim') {
          bases.push({ kind: 'verbatim', sourceIndex: input.sourceIndex });
        } else if (input.kind === 'standard') {
          bases.push({ kind: 'standard', plane: input.plane });
        } else if (input.kind === 'plane' || input.kind === 'wire') {
          bases.push({
            kind: input.kind,
            producer: mergeProducer({
              line: input.loc.line, column: input.loc.column,
              featureType: input.kind === 'plane' ? 'plane' : 'wire',
              nameHint: input.kind === 'plane' ? 'p' : 'e',
              bind: true,
            }),
          });
        } else {
          // Picks synthesize ONE AT A TIME — the kernel groups picks by
          // (producer, bucket), and a batched call would merge same-bucket
          // faces into one part, destroying the per-base arity.
          const synthesis = synthesizeSlot([input.pick], 'plane', undefined, []);
          if (!synthesis) {
            return;
          }
          // A base is ONE SceneObject — a multi-part selection has no
          // single-expression rendering.
          if (synthesis.spec.parts.length !== 1) {
            res.status(422).json({ success: false, reason: 'a plane base must be a single face or edge selection' });
            return;
          }
          bases.push({ kind: 'selector', part: foldSynthesis(synthesis) });
        }
      }
      edit.plane!.bases = bases;
    }
    if (request.sketchPicks) {
      // The 2D branch of synthesis: sketch-edge picks resolve through the
      // sketch's own edge index, so the re-picked targets render exactly
      // like the create dialog's — accessors, or an induced edge filter
      // (a slot's single source renders as its bare variable).
      const synthesis = fluidCadServer.synthesizeSketchApplyFeature(
        request.sketchPicks,
        request.feature === 'fillet' ? 'fillet'
          : request.feature === 'text' ? 'text' : 'offset',
        request.value,
        { ...synthOptions, offset: request.offset },
      );
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason });
        return;
      }
      // A text path must be ONE whole geometry referenced by a bare
      // variable — a workspace kernel predating the 'text' kind falls
      // through to its accessor synthesis and returns forms the text
      // build cannot consume; refuse those honestly.
      if (request.feature === 'text' && !/^[A-Za-z_$][\w$]*$/.test(synthesis.args)) {
        res.status(422).json({
          success: false,
          reason: "the workspace's FluidCAD version does not support picking a text path — update its fluidcad dependency",
        });
        return;
      }
      foldSynthesis(synthesis);
      synthesizedArgs = synthesis.args;
      alternatives = synthesis.alternatives;
      // The user's expression text wins only when it differs from what
      // the picks synthesize — the create path's contract.
      rawArgs = rawArgs !== undefined && rawArgs !== synthesis.args ? rawArgs : undefined;
    }
    if (request.projectSketches && request.projectSketches.length > 0) {
      // Whole-sketch sources bind as sketch producers rendered bare,
      // after the re-picked selectors; the expression row shows the
      // names the rewrite allocates.
      const sketchProducers = request.projectSketches.map(loc => mergeProducer({
        line: loc.line, column: loc.column, featureType: 'sketch', nameHint: 's', bind: true,
      }));
      for (const producer of sketchProducers) {
        parts.push({ producer, accessor: '', indices: null, filterArgs: null });
      }
      const producerVars = await allocateProducerVars(producers, code);
      const sketchArgs = sketchProducers.map((producer, i) => producerVars[producer] ?? `s${i === 0 ? '' : i + 1}`);
      const withSketches = (own: string | undefined): string =>
        [own ?? '', ...sketchArgs].filter(arg => arg !== '').join(', ');
      const ownArgs = synthesizedArgs;
      synthesizedArgs = withSketches(ownArgs);
      alternatives = alternatives.map(withSketches);
      rawArgs = rawArgs !== undefined && rawArgs !== synthesizedArgs ? rawArgs : undefined;
    }
    if (request.feature === 'boolean' && request.booleanTargets) {
      // Every re-picked target is a bound feature producer; keeps stay
      // text-addressed by their position in the statement.
      edit.boolean!.targets = request.booleanTargets.map(target => target.kind === 'verbatim'
        ? { kind: 'verbatim' as const, sourceIndex: target.sourceIndex }
        : {
          kind: 'feature' as const,
          producer: mergeProducer({
            line: target.loc.line, column: target.loc.column,
            featureType: 'feature', nameHint: 'f', bind: true,
          }),
        });
    }

    const spec: ApplyFeatureEditSpec = {
      feature: request.feature,
      value: request.value,
      offset: request.offset,
      rawArgs,
      filePath: request.target.filePath,
      producers,
      parts,
      imports: [...importSet],
      edit,
      newVariables,
      // Applying an edit clears the breakpoint the double-click placed —
      // inside the same transform, so it can't race the rewrite — and the
      // model rebuilds to its tip. The sketch retarget opens without a
      // double-click, so it has no breakpoint to clear (and must not
      // strip ones the user placed).
      clearBreakpoints: request.feature !== 'sketch',
    };
    // Truthful preview: parse the live buffer and render the exact
    // statement the transform will write, with the same variable names
    // the transform's binding walk allocates. Refusals (a reshaped
    // statement, a stale expectedStatement, a bad source list) surface
    // here, before any edit is sent.
    let statement: string | undefined;
    if (code) {
      const parsed = await parseFeatureStatement(code, request.edit.line);
      if (parsed.ok === false) {
        res.status(422).json({ success: false, reason: parsed.reason });
        return;
      }
      if (edit.expectedStatement !== undefined && parsed.statement !== edit.expectedStatement) {
        res.status(422).json({
          success: false,
          reason: 'the statement changed since the dialog opened — re-open it to edit the current code',
        });
        return;
      }
      const staged = spec.feature === 'loft' ? await LoftConnections.prepare(code, spec) : { code, spec };
      if ('error' in staged) {
        res.status(422).json({ success: false, reason: staged.error });
        return;
      }
      const vars = await allocateProducerVars(staged.spec.producers, staged.code);
      const rendered = renderEditedStatement(parsed.parsed, staged.spec, i => vars[i] ?? null);
      if ('error' in rendered) {
        res.status(422).json({ success: false, reason: rendered.error });
        return;
      }
      statement = rendered.statement;
    }
    if (preview === true) {
      res.json({
        success: true,
        preview: statement,
        args: synthesizedArgs,
        alternatives: alternatives.length > 0 ? alternatives : undefined,
      });
      return;
    }
    await dispatcher.dispatch(res, spec, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
