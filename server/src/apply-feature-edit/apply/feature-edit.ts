// The apply-feature-edit entry point: dispatches a spec to its transform and sweeps orphaned selections.

import { insertSketchImage, setPartAppearance, setPartMaterial, setSectionOptions, setSketchClosed, setSketchImage } from '../../code-editor/index.ts';
import { applySketchConstraint } from '../../sketch-constraint-edit.ts';
import { SketchSplit } from '../../sketch-split.ts';
import { SketchTrim } from '../../sketch-trim.ts';
import { SketchFillet } from '../../sketch-fillet.ts';
import { SketchEntityDelete } from '../../sketch-entity-delete.ts';
import { applyDistanceTangency, applySolvedEmission } from '../../sketch-solved-edit/index.ts';
import { ParamEditor } from '../../param-edit.ts';
import { ConfigurationEditor } from '../../configuration-edit.ts';
import { PropertyEditor } from '../../property-edit.ts';
import { DeclarationUsages } from '../../declaration-usages.ts';
import { InstanceRename } from '../../instance-rename.ts';
import { PartRename } from '../../part-rename.ts';
import { MoveToPart } from '../../move-to-part.ts';
import { TimelineBreakpoint } from '../../timeline-breakpoint.ts';
import { PauseAfter } from '../../pause-after.ts';
import { RemoveFeature } from '../../remove-feature.ts';
import { OrphanedSelections } from '../../orphaned-selections.ts';
import { applyInsertPartEdit } from '../../part-catalog/insert-edit.ts';
import { setInsertTransparency } from '../../insert-chain-edit.ts';
import { applyAssemblyExportEdit, applyConnectorPropsEdit } from '../../assembly-mate-edit.ts';
import { applyAssemblyRelationEdit } from '../../assembly-relation-edit.ts';
import { applyAssemblyReplicateEdit } from '../../assembly-replicate-edit.ts';
import {
  applyAssemblyConnectorCopyWithDecls,
  applyAssemblyConnectorWithDecls,
  applyAssemblyMateWithExposeCreates,
  applyInsertParamsWithDecls,
  applyInstancePoseWithDecls,
} from './assembly.ts';
import { applyCreateEdit, applyPlaneSketch, landNewVariableDecls } from './create.ts';
import { applyPlaneForeign, applyProjectForeign, applySketchForeign } from './foreign.ts';
import { applyNewPart } from './new-part.ts';
import { applyStatementEdit } from './statement-edit.ts';
import { LoftConnections } from '../loft-connections.ts';
import { HolePlacements } from '../hole-placements.ts';
import { CustomFeaturePoints } from '../custom-feature-points.ts';
import { SplitSeeds } from '../split-seeds.ts';
import { RegionDeclarations } from '../region-declarations.ts';
import { FeatureCallees, type FeatureCalleeSource } from '../producers/callees.ts';
import type { ApplyFeatureEditResult, ApplyFeatureEditSpec, FeatureEditApply } from '../spec.ts';

export type ApplyFeatureEditOptions = {
  /**
   * Where the edited file's custom features come from (the server's feature
   * catalog): their calls bind, repeat and move like the built-ins'. Left
   * out, only the built-in callees qualify.
   */
  callees?: FeatureCalleeSource;
  /**
   * The global-parameters catalog, so an expression that names a project
   * parameter gets its import written (§2.8). Absent — a nested staging
   * call, a test — no import pass runs.
   */
  globals?: GlobalParamCatalog;
};

/**
 * What one edit's transform arms share: the file's custom feature callees,
 * resolved on first use (most specs never bind a producer), and the edit
 * itself with the same options, for the arms that stage a nested edit.
 */
class EditContext {
  private resolved: Promise<FeatureCallees> | null = null;

  constructor(
    private readonly code: string,
    private readonly filePath: string | undefined,
    private readonly options: ApplyFeatureEditOptions,
  ) {}

  readonly apply: FeatureEditApply = (code, spec) => applyFeatureEdit(code, spec, this.options);

  callees(): Promise<FeatureCallees> {
    if (!this.resolved) {
      const source = this.options.callees;
      this.resolved = source && this.filePath
        ? source.calleesFor(this.code, this.filePath)
        : Promise.resolve(FeatureCallees.BUILT_IN);
    }
    return this.resolved;
  }
}
import { GlobalImports } from '../global-imports.ts';
import type { GlobalParamCatalog } from '../../global-params/catalog.ts';

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
  options: ApplyFeatureEditOptions = {},
): Promise<ApplyFeatureEditResult> {
  // Navigation must only change the breakpoint, without sweeping selections.
  if (spec.timelineBreakpoint) return TimelineBreakpoint.apply(code, spec.timelineBreakpoint);
  if (spec.pauseAfter) return PauseAfter.apply(code, spec.pauseAfter);
  const result = await applyFeatureEditTransform(code, spec, new EditContext(code, spec.filePath, options));
  if (result.error) {
    return result;
  }
  let newCode = await OrphanedSelections.sweep(code, result.newCode);
  // Every path a dialog expression reaches source through — statement
  // create and edit, the declarations they land, an insert's `{ expr }`
  // values, a sketch emission's constraint values — ends here, so the one
  // import pass over the spec's expressions covers them all.
  if (options.globals) {
    newCode = await GlobalImports.ensure(newCode, spec.filePath, GlobalImports.expressionsOf(spec), options.globals);
  }
  return { ...result, newCode };
}

async function applyFeatureEditTransform(
  code: string,
  spec: ApplyFeatureEditSpec,
  context: EditContext,
): Promise<ApplyFeatureEditResult> {
  if (spec.feature === 'loft' && LoftConnections.hasExports(spec)) {
    const staged = await LoftConnections.prepare(code, spec);
    if ('error' in staged) {
      return { newCode: code, error: staged.error };
    }
    const result = await applyFeatureEditTransform(staged.code, staged.spec, context);
    return result.error ? { newCode: code, error: result.error } : result;
  }

  // Hole placements that name a sketch point or ask for a new connector are
  // authored first (the export, the connector statement), then the hole
  // renders their names — one atomic write, like the loft exports.
  if (spec.feature === 'hole' && HolePlacements.needsStaging(spec)) {
    const staged = await HolePlacements.prepare(code, spec, context.apply);
    if ('error' in staged) {
      return { newCode: code, error: staged.error };
    }
    const result = await applyFeatureEditTransform(staged.code, staged.spec, context);
    return result.error ? { newCode: code, error: result.error } : result;
  }

  // A custom feature's picked sketch points are exported from their
  // sketches first; the statement then names each by its export.
  if (CustomFeaturePoints.needsStaging(spec)) {
    const staged = await CustomFeaturePoints.prepare(code, spec);
    if ('error' in staged) {
      return { newCode: code, error: staged.error };
    }
    const result = await applyFeatureEditTransform(staged.code, staged.spec, context);
    return result.error ? { newCode: code, error: result.error } : result;
  }

  // A split seeded by a sketched line exports the line from its sketch
  // first (`s.geometries.l`), then the statement renders the name — one
  // atomic write, like the hole's sketch point placements.
  if (SplitSeeds.needsStaging(spec)) {
    const staged = await SplitSeeds.prepare(code, spec);
    if ('error' in staged) {
      return { newCode: code, error: staged.error };
    }
    const result = await applyFeatureEditTransform(staged.code, staged.spec, context);
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
    const result = await applyFeatureEditTransform(staged.code, staged.spec, context);
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
  if (spec.sketchFillet) {
    const { newCode, error } = await SketchFillet.apply(code, spec.sketchFillet);
    return { newCode, ...(error !== undefined ? { error } : {}) };
  }
  if (spec.sketchDelete) {
    const { newCode, error } = await SketchEntityDelete.apply(code, spec.sketchDelete);
    return { newCode, ...(error !== undefined ? { error } : {}) };
  }
  if (spec.paramEdit) {
    return ParamEditor.apply(code, spec.paramEdit, spec.filePath);
  }
  if (spec.configurationEdit) {
    return ConfigurationEditor.apply(code, spec.configurationEdit);
  }
  if (spec.propertyEdit) {
    return PropertyEditor.apply(code, spec.propertyEdit, spec.filePath);
  }
  if (spec.usageEdit) {
    return DeclarationUsages.apply(code, spec.filePath, spec.usageEdit);
  }
  if (spec.insertPart) {
    const result = await applyInsertPartEdit(code, spec.insertPart);
    if (result.error) return result;
    return landNewVariableDecls(code, result.newCode, result.statementLine!, spec.newVariables);
  }
  if (spec.newPart) {
    return applyNewPart(code, spec.newPart);
  }
  if (spec.moveToPart) {
    return MoveToPart.apply(code, spec.moveToPart, await context.callees());
  }
  if (spec.removeFeature) {
    return RemoveFeature.apply(code, spec.removeFeature);
  }
  if (spec.sketchClosed) {
    return setSketchClosed(code, spec.sketchClosed.sourceLine, spec.sketchClosed.closed);
  }
  if (spec.sketchImage) {
    const edit = spec.sketchImage;
    return 'sketchLine' in edit
      ? insertSketchImage(code, edit.sketchLine, edit.image)
      : setSketchImage(code, edit.imageLine, edit.image);
  }
  if (spec.partMaterial) {
    return setPartMaterial(code, spec.partMaterial.sourceLine, spec.partMaterial.material);
  }
  if (spec.partAppearance) {
    return setPartAppearance(code, spec.partAppearance.sourceLine, spec.partAppearance.appearance);
  }
  if (spec.sectionOptions) {
    const so = spec.sectionOptions;
    return setSectionOptions(code, so.sourceLine, { offset: so.offset, flip: so.flip });
  }
  if (spec.instancePose) {
    return applyInstancePoseWithDecls(code, spec);
  }
  if (spec.insertParams) {
    return applyInsertParamsWithDecls(code, spec);
  }
  if (spec.instanceRename) {
    return InstanceRename.apply(code, spec.filePath, spec.instanceRename);
  }
  if (spec.instanceTransparency) {
    return setInsertTransparency(code, spec.instanceTransparency.sourceLine, spec.instanceTransparency.transparency);
  }
  if (spec.partRename) {
    return PartRename.apply(code, spec.filePath, spec.partRename);
  }
  if (spec.assemblyMate) {
    return applyAssemblyMateWithExposeCreates(code, spec.assemblyMate, context.apply);
  }
  if (spec.assemblyConnector) {
    return applyAssemblyConnectorWithDecls(code, spec);
  }
  if (spec.assemblyConnectorCopy) {
    return applyAssemblyConnectorCopyWithDecls(code, spec);
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
  if (spec.assemblyRelation) {
    return applyAssemblyRelationEdit(code, spec.assemblyRelation);
  }
  if (spec.edit) {
    return applyStatementEdit(code, spec, await context.callees());
  }
  if (spec.feature === 'sketch' && spec.sketchForeign) {
    return applySketchForeign(code, spec, context.apply);
  }
  if (spec.feature === 'project' && spec.project?.foreign?.length) {
    return applyProjectForeign(code, spec, context.apply, await context.callees());
  }
  if (spec.feature === 'plane' && spec.plane?.foreign?.length) {
    return applyPlaneForeign(code, spec, context.apply, await context.callees());
  }
  if (spec.feature === 'sketch' && spec.producers.length === 0 && spec.parts.length === 0) {
    return applyPlaneSketch(code, spec.sketchPlane, spec.activePart);
  }
  return applyCreateEdit(code, spec, { callees: await context.callees() });
}
