// Assembly edits that ride the feature-edit transform: instance poses, connectors, insert params and mates with nested exposures.

import { getJavaScriptParser, isExpressionText, walkTree } from '../../code-editor/index.ts';
import { applyInstancePoseEdit } from '../../insert-chain-edit.ts';
import { applyAssemblyConnectorEdit } from '../../assembly-connector-edit.ts';
import { applyInsertParamsEdit } from '../../insert-params-edit.ts';
import { applyAssemblyMateEdit, mateSideRefs, type AssemblyMateEditSpec } from '../../assembly-mate-edit.ts';
import { landNewVariableDecls } from './create.ts';
import type { ApplyFeatureEditResult, ApplyFeatureEditSpec, FeatureEditApply } from '../spec.ts';

/**
 * The `instancePose` side-channel plus its expression extras: validate the
 * per-axis translate texts as safe single-argument expressions, apply the
 * chain rewrite, then land any declarations the gizmo's absolute-value input
 * committed — plain `const`s directly before the insert statement at its
 * indent, `param()` declarations in the enclosing part body or after the
 * imports (import ensured) — mirroring the dialog expression fields.
 * Declarations splice after the pose edit so the spec's source line stays
 * valid throughout.
 */
export async function applyInstancePoseWithDecls(
  code: string,
  spec: ApplyFeatureEditSpec,
): Promise<ApplyFeatureEditResult> {
  const pose = spec.instancePose!;
  for (const expr of [...(pose.translateExprs ?? []), ...(pose.rotateExprs ?? [])]) {
    if (expr !== null && !isExpressionText(expr)) {
      return { newCode: code, error: 'malformed pose expression' };
    }
  }
  const result = await applyInstancePoseEdit(code, pose);
  if (result.error !== undefined) {
    return result;
  }
  return landNewVariableDecls(code, result.newCode, pose.sourceLine, spec.newVariables);
}

/**
 * The `assemblyConnector` side-channel plus its expression extras, exactly
 * like the pose gizmo's: validate the per-axis texts, apply the statement
 * write, then land any declarations before the written statement.
 */
export async function applyAssemblyConnectorWithDecls(
  code: string,
  spec: ApplyFeatureEditSpec,
): Promise<ApplyFeatureEditResult> {
  const connector = spec.assemblyConnector!;
  for (const expr of [...(connector.positionExprs ?? []), ...(connector.rotateExprs ?? [])]) {
    if (expr !== null && !isExpressionText(expr)) {
      return { newCode: code, error: 'malformed connector expression' };
    }
  }
  const result = await applyAssemblyConnectorEdit(code, connector);
  if (result.error !== undefined) {
    return { newCode: code, error: result.error };
  }
  return landNewVariableDecls(code, result.newCode, result.statementLine!, spec.newVariables);
}

/**
 * The Edit-parameters dialog's `insertParams` side-channel plus its
 * expression extras: merge the changed values (verbatim `{ expr }` texts
 * included — `applyInsertParamsEdit` validates them), then land any
 * declarations the dialog's expression fields committed, exactly like the
 * pose gizmo's.
 */
export async function applyInsertParamsWithDecls(
  code: string,
  spec: ApplyFeatureEditSpec,
): Promise<ApplyFeatureEditResult> {
  const result = await applyInsertParamsEdit(code, spec.insertParams!);
  if (result.error !== undefined) {
    return result;
  }
  return landNewVariableDecls(code, result.newCode, spec.insertParams!.line, spec.newVariables);
}

/**
 * The tangent mate's same-file find-or-create fold: apply every embedded
 * `'expose'` create-spec first, relocating the mate payload's line anchors
 * across each intermediate edit by insert()/mate() call ORDINALS (exposure
 * edits never add or remove insert()/mate() calls, so the k-th call before
 * is the k-th call after), then run the ordinary mate transform — one
 * document replacement, atomic. Cross-file creations ride their own
 * dispatches to the donor files instead (the route sequences them).
 */
export async function applyAssemblyMateWithExposeCreates(
  code: string,
  mateSpec: AssemblyMateEditSpec,
  apply: FeatureEditApply,
): Promise<ApplyFeatureEditResult> {
  const creates = (mateSpec.exposeCreates ?? []) as ApplyFeatureEditSpec[];
  if (creates.length === 0) {
    return applyAssemblyMateEdit(code, mateSpec);
  }
  if (creates.some(c => c.feature !== 'expose' || c.assemblyMate !== undefined)) {
    return { newCode: code, error: 'malformed tangent mate spec: exposeCreates must be expose specs' };
  }
  const payload = mateSpec.create ?? mateSpec.edit;
  const sides = payload ? mateSideRefs(payload) : null;
  if (!payload || !sides) {
    return { newCode: code, error: 'malformed tangent mate spec: missing geometry sides' };
  }

  let working = code;
  let lineA = sides.a.instanceLine;
  let lineB = sides.b.instanceLine;
  let mateLine = mateSpec.edit?.sourceLine;
  for (const create of creates) {
    const insertsBefore = await callLines(working, 'insert');
    const matesBefore = await callLines(working, 'mate');
    const applied = await apply(working, create);
    if (applied.error) {
      return { newCode: code, error: applied.error };
    }
    const insertsAfter = await callLines(applied.newCode, 'insert');
    const matesAfter = await callLines(applied.newCode, 'mate');
    const relocate = (line: number, before: number[], after: number[]): number | null => {
      const k = before.indexOf(line);
      return k >= 0 && before.length === after.length ? after[k] : null;
    };
    const newA = relocate(lineA, insertsBefore, insertsAfter);
    const newB = relocate(lineB, insertsBefore, insertsAfter);
    const newMate = mateLine !== undefined ? relocate(mateLine, matesBefore, matesAfter) : undefined;
    if (newA === null || newB === null || newMate === null) {
      return {
        newCode: code,
        error: 'could not relocate the insert()/mate() statements after the exposure edit — is the file in sync with the last render?',
      };
    }
    working = applied.newCode;
    lineA = newA;
    lineB = newB;
    mateLine = newMate;
  }

  const patchSides = (p: NonNullable<AssemblyMateEditSpec['create']>) => ({
    ...p,
    ...(p.connectorA && p.connectorB
      ? {
        connectorA: { ...p.connectorA, instanceLine: lineA },
        connectorB: { ...p.connectorB, instanceLine: lineB },
      }
      : {
        geometryA: { ...p.geometryA!, instanceLine: lineA },
        geometryB: { ...p.geometryB!, instanceLine: lineB },
      }),
  });
  const patched: AssemblyMateEditSpec = mateSpec.create
    ? { create: patchSides(mateSpec.create) }
    : { edit: { ...patchSides(mateSpec.edit!), sourceLine: mateLine! } };
  return applyAssemblyMateEdit(working, patched);
}

/** Start lines (1-based) of every `<callee>(...)` call, in document order. */
async function callLines(code: string, callee: string): Promise<number[]> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const out: number[] = [];
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    const fn = node.childForFieldName('function');
    if (fn?.type === 'identifier' && fn.text === callee) {
      out.push(node.startPosition.row + 1);
    }
  }
  return out;
}
