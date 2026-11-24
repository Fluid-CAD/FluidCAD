// POST /apply-feature, the extrude create branch.

import type { Request, Response } from 'express';
import {
  extractNumericParams,
  makeProducerNamer,
  renderExtrudeStatement,
  renderFaceTargetExpr,
  renderSelectorPartExpr,
  resolveParamValues,
  type ApplyFeatureEditSpec,
  type ExtrudeEditOptions,
  type ExtrudeTargetKind,
} from '../../../apply-feature-edit/index.ts';
import { RegionDeclarations } from '../../../apply-feature-edit/region-declarations.ts';
import { scopeCrossFileError } from '../locations.ts';
import type { Pick } from '../picks.ts';
import { allocateProducerVars, makeProducerMerger, mergeScopeProducers } from '../synthesis.ts';
import { validateExtrude } from '../validate/extrude.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// Extrude's profile is a sketch statement, never a pick selection — the
// transform re-verifies that the line holds a sketch() call — or a face
// picked on a solid, synthesized into a face selector that renders as the
// trailing argument. The optional up-to-face target replaces the
// distance(s) as the call's first argument: a picked face synthesizes a
// face selector, while 'first-face'/'last-face' render as that literal —
// no pick involved, the kernel resolves the face at build time.
export async function handleExtrude(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables, activePartFor } = ctx;
  const request = validateExtrude(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  const sketchProfile = request.profile.mode === 'face' ? null : request.profile;
  // A sketch profile names the file up front; a face profile's comes from
  // the statements its selector reads.
  let filePath: string | null = sketchProfile?.filePath ?? null;
  try {
    const code = fluidCadServer.getCurrentCode();
    // A sketch profile stays producers[0] — the transform's extrude
    // contract; the face selectors' producers follow it, merged by call
    // site (a face profile and the target can sit on the same solid). An
    // offset profile binds under its own callee guard and hint.
    const { producers, merge: mergeProducer } = makeProducerMerger();
    const profileHint = sketchProfile?.feature === 'offset' ? 'o' : 's';
    if (sketchProfile) {
      mergeProducer({
        line: sketchProfile.line,
        column: sketchProfile.column,
        featureType: sketchProfile.feature,
        nameHint: profileHint,
        bind: sketchProfile.mode === 'bound',
      });
    }
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const imports = new Set<string>();
    let faceArgs: string | null = null;
    let toFace: ExtrudeTargetKind | undefined;
    let toFacePart: number | undefined;
    let profilePart: number | undefined;

    // Built on the first picked face — a sketch extrude to a distance never
    // runs synthesis.
    let synthOptions: {
      namer: Awaited<ReturnType<typeof makeProducerNamer>>;
      params: { name: string; value: number }[];
    } | undefined;
    let synthOptionsReady = false;
    /** One picked face as its own selector part; null after refusing with a response. */
    const synthesizeFace = async (
      pick: Pick,
      errors: { multi: string; crossFile: string },
    ): Promise<number | null> => {
      if (!synthOptionsReady) {
        synthOptionsReady = true;
        if (code) {
          synthOptions = {
            namer: await makeProducerNamer(code, await ctx.currentCallees()),
            params: resolveParamValues(
              await extractNumericParams(code),
              fluidCadServer.getParamDefinitions(),
            ),
          };
        }
      }
      const synthesis = fluidCadServer.synthesizeApplyFeature(
        [pick], 'extrude', undefined, [], synthOptions,
      );
      if (!synthesis) {
        res.status(404).json({ success: false, reason: 'No rendered scene' });
        return null;
      }
      if (!synthesis.ok) {
        res.status(422).json({ success: false, reason: synthesis.reason, pick: synthesis.pick });
        return null;
      }
      // The argument is ONE SceneObject — a multi-part selection has no
      // single-expression rendering.
      if (synthesis.spec.parts.length !== 1) {
        res.status(422).json({ success: false, reason: errors.multi });
        return null;
      }
      if (filePath !== null && synthesis.spec.filePath !== filePath) {
        res.status(422).json({ success: false, reason: errors.crossFile });
        return null;
      }
      filePath = synthesis.spec.filePath;
      const remap = synthesis.spec.producers.map(mergeProducer);
      const part = synthesis.spec.parts[0];
      parts.push({
        ...part,
        producer: part.producer === null ? null : remap[part.producer],
        refs: part.refs ? part.refs.map((i: number) => remap[i]) : part.refs,
      });
      for (const symbol of synthesis.spec.imports) {
        imports.add(symbol);
      }
      return parts.length - 1;
    };

    if (request.profile.mode === 'face') {
      const part = await synthesizeFace(request.profile.pick, {
        multi: 'the extrude profile must be a single face selection',
        crossFile: 'the profile face and the target face come from different files',
      });
      if (part === null) {
        return;
      }
      profilePart = part;
    }
    if (request.toFace === 'first-face' || request.toFace === 'last-face') {
      toFace = request.toFace;
      faceArgs = renderFaceTargetExpr(request.toFace);
    } else if (request.toFace) {
      const part = await synthesizeFace(request.toFace, {
        multi: 'the extrude target must be a single face selection',
        crossFile: sketchProfile
          ? 'the target face and the profile sketch come from different files'
          : 'the profile face and the target face come from different files',
      });
      if (part === null) {
        return;
      }
      toFacePart = part;
      toFace = 'selector';
    }
    if (filePath === null) {
      // Unreachable: a sketch profile names the file, a face one synthesized it.
      res.status(422).json({ success: false, reason: 'the extrude has no profile' });
      return;
    }
    const crossFile = scopeCrossFileError(request.scope, filePath);
    if (crossFile) {
      res.status(422).json({ success: false, reason: crossFile });
      return;
    }

    const scope = mergeScopeProducers(producers, request.scope);
    const options: ExtrudeEditOptions = {
      op: request.op,
      distance: request.distance,
      distance2: request.distance2,
      symmetric: request.symmetric,
      draft: request.draft,
      endOffset: request.endOffset,
      drill: request.drill,
      thin: request.thin,
      profile: !sketchProfile ? 'face' : sketchProfile.mode === 'bound' ? 'bound' : 'implicit',
      ...(profilePart !== undefined ? { profilePart } : {}),
      toFace,
      ...(toFacePart !== undefined ? { toFacePart } : {}),
      scope,
      // A face is swept as it stands — it has no regions to declare.
      ...(sketchProfile
        ? {
          regionPicks: request.regions,
          regionSketch: { line: sketchProfile.line, column: sketchProfile.column },
          // The preview shows the names the transform will write.
          regions: await RegionDeclarations.planNames(code, sketchProfile.line, request.regions),
        }
        : {}),
    };
    // Truthful preview names: the same resolution the transform runs
    // (reused consts, collision-suffixed hints).
    const producerVars = await allocateProducerVars(producers, code, await ctx.currentCallees());
    const partExpr = (index: number): string => {
      const part = parts[index];
      return renderSelectorPartExpr(part,
        part.producer === null ? null : producerVars[part.producer], i => producerVars[i] ?? null);
    };
    if (toFacePart !== undefined) {
      faceArgs = partExpr(toFacePart);
    }
    const profileExpr = profilePart !== undefined
      ? partExpr(profilePart)
      : sketchProfile?.mode === 'bound' ? producerVars[0] ?? profileHint : null;
    const statement = renderExtrudeStatement(
      options, profileExpr, faceArgs, scope.map(index => producerVars[index] ?? 'f'),
    );
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    const activePart = activePartFor(filePath);
    await dispatcher.dispatch(res, {
      feature: 'extrude',
      extrude: options,
      filePath,
      producers,
      parts,
      imports: [...imports],
      newVariables,
      ...(activePart ? { activePart } : {}),
    }, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
