// The apply-feature-edit entry point: dispatches a spec to its transform and sweeps orphaned selections.

import { setSketchClosed } from '../../code-editor/index.ts';
import { applySketchConstraint } from '../../sketch-constraint-edit.ts';
import { SketchSplit } from '../../sketch-split.ts';
import { SketchTrim } from '../../sketch-trim.ts';
import { SketchEntityDelete } from '../../sketch-entity-delete.ts';
import { applyDistanceTangency, applySolvedEmission } from '../../sketch-solved-edit/index.ts';
import { ParamEditor } from '../../param-edit.ts';
import { MoveToPart } from '../../move-to-part.ts';
import { RemoveFeature } from '../../remove-feature.ts';
import { OrphanedSelections } from '../../orphaned-selections.ts';
import { applyInsertPartEdit } from '../../part-catalog/insert-edit.ts';
import { applyAssemblyExportEdit, applyConnectorPropsEdit } from '../../assembly-mate-edit.ts';
import { applyAssemblyReplicateEdit } from '../../assembly-replicate-edit.ts';
import {
  applyAssemblyConnectorWithDecls,
  applyAssemblyMateWithExposeCreates,
  applyInsertParamsWithDecls,
  applyInstancePoseWithDecls,
} from './assembly.ts';
import { applyCreateEdit, applyPlaneSketch } from './create.ts';
import { applyProjectForeign, applySketchForeign } from './foreign.ts';
import { applyNewPart } from './new-part.ts';
import { applyStatementEdit } from './statement-edit.ts';
import { LoftConnections } from '../loft-connections.ts';
import { RegionDeclarations } from '../region-declarations.ts';
import type { ApplyFeatureEditResult, ApplyFeatureEditSpec } from '../spec.ts';

/**
 * Apply a synthesized feature statement (fillet/chamfer/shell/sketch) to
 * source text: bind each producer call to a variable (reusing an existing
 * `const`, or prepending `const <name> = ` to a bare expression statement),
 * append the feature statement at the end of the producers' enclosing scope,
 * and ensure the feature is imported. A sketch statement carries an empty
 * multi-line callback body instead of a numeric parameter.
 *
 * Pure string-in/string-out; returns `{ newCode: code, error }` and changes
 * nothing when the edit cannot be applied safely.
 *
 * Whatever the edit was, the `select()` declarations it left without a
 * reference go with it (a deleted loft's connection selections, a re-picked
 * projection's old source) — see {@link OrphanedSelections}.
 */
export async function applyFeatureEdit(
  code: string,
  spec: ApplyFeatureEditSpec,
): Promise<ApplyFeatureEditResult> {
  const result = await applyFeatureEditTransform(code, spec);
  if (result.error) {
    return result;
  }
  return { ...result, newCode: await OrphanedSelections.sweep(code, result.newCode) };
}

async function applyFeatureEditTransform(
  code: string,
  spec: ApplyFeatureEditSpec,
): Promise<ApplyFeatureEditResult> {
  if (spec.feature === 'loft' && LoftConnections.hasExports(spec)) {
    const staged = await LoftConnections.prepare(code, spec);
    if ('error' in staged) {
      return { newCode: code, error: staged.error };
    }
    const result = await applyFeatureEditTransform(staged.code, staged.spec);
    return result.error ? { newCode: code, error: result.error } : result;
  }

  // Region picks become declarations in the profile sketch first; the
  // statement then renders the names. Like the loft exports, a refusal
  // never returns a partially edited buffer.
  if (RegionDeclarations.workOf(spec)) {
    const staged = await RegionDeclarations.prepare(code, spec);
    if ('error' in staged) {
      return { newCode: code, error: staged.error };
    }
    const result = await applyFeatureEditTransform(staged.code, staged.spec);
    return result.error ? { newCode: code, error: result.error } : result;
  }

  if (spec.sketchConstraint) {
    return applySketchConstraint(code, spec.sketchConstraint);
  }
  if (spec.sketchEmission) {
    const { newCode, error } = await applySolvedEmission(code, spec.sketchEmission);
    return { newCode, ...(error !== undefined ? { error } : {}) };
  }
  if (spec.distanceTangency) {
    return applyDistanceTangency(code, spec.distanceTangency);
  }
  if (spec.sketchSplit) {
    const { newCode, error } = await SketchSplit.apply(code, spec.sketchSplit);
    return { newCode, ...(error !== undefined ? { error } : {}) };
  }
  if (spec.sketchTrim) {
    const { newCode, error } = await SketchTrim.apply(code, spec.sketchTrim);
    return { newCode, ...(error !== undefined ? { error } : {}) };
  }
  if (spec.sketchDelete) {
    const { newCode, error } = await SketchEntityDelete.apply(code, spec.sketchDelete);
    return { newCode, ...(error !== undefined ? { error } : {}) };
  }
  if (spec.paramEdit) {
    return ParamEditor.apply(code, spec.paramEdit);
  }
  if (spec.insertPart) {
    return applyInsertPartEdit(code, spec.insertPart);
  }
  if (spec.newPart) {
    return applyNewPart(code, spec.newPart);
  }
  if (spec.moveToPart) {
    return MoveToPart.apply(code, spec.moveToPart);
  }
  if (spec.removeFeature) {
    return RemoveFeature.apply(code, spec.removeFeature);
  }
  if (spec.sketchClosed) {
    return setSketchClosed(code, spec.sketchClosed.sourceLine, spec.sketchClosed.closed);
  }
  if (spec.instancePose) {
    return applyInstancePoseWithDecls(code, spec);
  }
  if (spec.insertParams) {
    return applyInsertParamsWithDecls(code, spec);
  }
  if (spec.assemblyMate) {
    return applyAssemblyMateWithExposeCreates(code, spec.assemblyMate, applyFeatureEdit);
  }
  if (spec.assemblyConnector) {
    return applyAssemblyConnectorWithDecls(code, spec);
  }
  if (spec.connectorProps) {
    return applyConnectorPropsEdit(code, spec.connectorProps);
  }
  if (spec.assemblyReplicate) {
    return applyAssemblyReplicateEdit(code, spec.assemblyReplicate);
  }
  if (spec.assemblyExport) {
    return applyAssemblyExportEdit(code, spec.assemblyExport);
  }
  if (spec.edit) {
    return applyStatementEdit(code, spec);
  }
  if (spec.feature === 'sketch' && spec.sketchForeign) {
    return applySketchForeign(code, spec, applyFeatureEdit);
  }
  if (spec.feature === 'project' && spec.project?.foreign?.length) {
    return applyProjectForeign(code, spec, applyFeatureEdit);
  }
  if (spec.feature === 'sketch' && spec.producers.length === 0 && spec.parts.length === 0) {
    return applyPlaneSketch(code, spec.sketchPlane, spec.activePart);
  }
  return applyCreateEdit(code, spec);
}
