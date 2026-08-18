import { ParsedScopeChain, ScopeTargetRef, SketchSourceRef } from '../../api';
import { SceneObjectRender, SourceLocation } from '../../types';
import { PickSlotChip } from '../pick-slot';
import { findActivePart, findEnclosingPartRow } from '../../helpers/scene-utils';
import { collectSolidTargets, solidTargetForRow, solidTargetForShapeId, SolidTargetOption } from './solid-targets';
import { sourceChip } from './sketch-profiles';

/**
 * One chosen `.scope(…)` target: a whole-solid pick resolved to its
 * statement, or — edit mode only — a kept argument by its position in the
 * parsed `scopeTexts`, preserved verbatim. A keep whose expression resolved
 * to a statement carries that statement's location (`loc`): it converts into
 * its solid option at the rollback boundary, so the chip shows the
 * statement's own label and a re-pick toggles it like create mode.
 */
export type ScopeTargetChoice =
  | { kind: 'option'; option: SolidTargetOption }
  | { kind: 'keep'; sourceIndex: number; label: string; loc?: SourceLocation };

/**
 * The solid statements a scope picker may offer, honoring variable scoping:
 * with a part location, only solids inside that part (their bound variables
 * are visible from the statement being written there); without one, only
 * top-level solids — a top-level statement cannot reference a const declared
 * inside a part() body. A part location that no longer resolves offers
 * nothing rather than leaking the whole scene.
 */
export function partScopedSolidTargets(
  sceneObjects: SceneObjectRender[],
  partLoc: SourceLocation | null,
): SolidTargetOption[] {
  const all = collectSolidTargets(sceneObjects);
  const inPart = (option: SolidTargetOption): SceneObjectRender | undefined => {
    const row = sceneObjects.find(o => o.sourceLocation?.filePath === option.filePath
      && o.sourceLocation?.line === option.line);
    return row ? findEnclosingPartRow(row, sceneObjects) : undefined;
  };
  if (partLoc === null) {
    return all.filter(option => inPart(option) === undefined);
  }
  const part = sceneObjects.find(o => o.type === 'part' && !o.parentId
    && o.sourceLocation?.filePath === partLoc.filePath && o.sourceLocation?.line === partLoc.line);
  if (!part) {
    return [];
  }
  return all.filter(option => inPart(option)?.id === part.id);
}

/**
 * The part() enclosing the statement at `loc`, resolved through its rendered
 * rows, or null for a top-level statement. Feeds the scope picker's part
 * restriction: a statement inside a part can only scope that part's solids.
 */
export function enclosingPartLocOf(
  loc: { filePath: string; line: number },
  sceneObjects: SceneObjectRender[],
): SourceLocation | null {
  const row = sceneObjects.find(o => o.sourceLocation?.filePath === loc.filePath
    && o.sourceLocation?.line === loc.line);
  if (!row) {
    return null;
  }
  return findEnclosingPartRow(row, sceneObjects)?.sourceLocation ?? null;
}

/**
 * The part whose solids a CREATE dialog may scope to: the enclosing part of
 * the primary input statement when one is chosen — producers win, the new
 * statement inserts in ITS scope — else the timeline's active part. Null
 * means top level (scope offers only top-level solids).
 */
export function scopePartLocation(
  primary: { filePath: string; line: number } | null,
  sceneObjects: SceneObjectRender[],
): SourceLocation | null {
  if (primary) {
    return enclosingPartLocOf(primary, sceneObjects);
  }
  return findActivePart(sceneObjects)?.sourceLocation ?? null;
}

/**
 * The `.scope(…)` target list every scope-picking dialog shares (rib,
 * extrude, sweep, loft, revolve): the offered solid options (part-scoped),
 * the chosen targets in pick order, their re-matching across renders and
 * edit-session boundaries, and the request/chip/highlight projections. The
 * owning service routes picks in and repaints from the projections — this
 * class holds no DOM and calls no API.
 */
export class ScopeTargetList {
  private options: SolidTargetOption[] = [];
  private choices: ScopeTargetChoice[] = [];

  /** No targets chosen — the statement gets no `.scope(…)` chain. */
  get isEmpty(): boolean {
    return this.choices.length === 0;
  }

  /** The chosen targets, in pick order (read-only — mutate via the methods). */
  get entries(): readonly ScopeTargetChoice[] {
    return this.choices;
  }

  /**
   * Rebuild the offered solids from a fresh scene and re-match the chosen
   * targets. Picked options re-match by source line — shape ids died with
   * the render — and drop when their statement stopped offering a solid (or
   * left the part scope). Keeps survive as text-addressed entries; with
   * `resolveKeeps` (the edit session's rollback boundary, where the offered
   * options ARE the statement's world) a keep whose argument named a
   * statement converts into that statement's option — proper label,
   * create-mode toggling.
   */
  setScene(
    sceneObjects: SceneObjectRender[],
    partLoc: SourceLocation | null,
    opts: { resolveKeeps?: boolean } = {},
  ): void {
    this.options = partScopedSolidTargets(sceneObjects, partLoc);
    this.choices = this.choices.flatMap((choice): ScopeTargetChoice[] => {
      if (choice.kind === 'keep') {
        if (!opts.resolveKeeps) {
          return [choice];
        }
        const match = choice.loc && this.options.find(o =>
          o.filePath === choice.loc!.filePath && o.line === choice.loc!.line);
        return match ? [{ kind: 'option', option: match }] : [choice];
      }
      const match = this.options.find(o =>
        o.filePath === choice.option.filePath && o.line === choice.option.line);
      return match ? [{ kind: 'option', option: match }] : [];
    });
  }

  /** The offered option owning a picked solid shape, or undefined. */
  optionForShapeId(shapeId: string): SolidTargetOption | undefined {
    return solidTargetForShapeId(shapeId, this.options);
  }

  /** The offered option a timeline row resolves to, or undefined. */
  optionForRow(obj: SceneObjectRender): SolidTargetOption | undefined {
    return solidTargetForRow(obj, this.options);
  }

  /**
   * Toggle a whole-solid pick (viewport or timeline). A kept target that
   * resolved to the same statement counts as the same chip — the pick
   * toggles it off instead of duplicating the solid.
   */
  toggle(option: SolidTargetOption): void {
    const existing = this.choices.findIndex(choice => choice.kind === 'option'
      ? choice.option.filePath === option.filePath && choice.option.line === option.line
      : choice.loc !== undefined && choice.loc.filePath === option.filePath && choice.loc.line === option.line);
    if (existing >= 0) {
      this.choices.splice(existing, 1);
    } else {
      this.choices.push({ kind: 'option', option });
    }
  }

  /** Remove the chip at `index` (its ✕). */
  removeAt(index: number): void {
    this.choices.splice(index, 1);
  }

  /** Drop every chosen target (dialog exit / fresh arm). */
  clear(): void {
    this.choices = [];
  }

  /**
   * Seed the list from an edited statement's parsed `.scope(…)` chain: one
   * kept chip per argument, each re-picked and toggled like create mode.
   */
  seedKeeps(parsed: ParsedScopeChain, targetFilePath: string): void {
    this.choices = parsed.scopeTexts.map((label, sourceIndex) => {
      const ref = parsed.scopeRefs[sourceIndex];
      return {
        kind: 'keep' as const,
        sourceIndex,
        label,
        loc: ref ? { filePath: targetFilePath, line: ref.line, column: ref.column } : undefined,
      };
    });
  }

  /** The chip row for the panel's scope slot, in pick order. */
  chips(): PickSlotChip[] {
    return this.choices.map(choice => choice.kind === 'keep'
      ? { label: `Current: ${choice.label}`, removable: true }
      : sourceChip(choice.option, { removable: true }));
  }

  /** The chosen solids' shape ids, for the whole-solid highlight. */
  shapeIds(): string[] {
    return this.choices.flatMap(choice => choice.kind === 'option' ? choice.option.shapeIds : []);
  }

  /** The create request's scope list — every chip is a picked solid. */
  createRefs(): SketchSourceRef[] {
    return this.choices.flatMap(choice => choice.kind === 'option'
      ? [{ filePath: choice.option.filePath, line: choice.option.line, column: choice.option.column }]
      : []);
  }

  /**
   * The edit request's full replacement list: kept arguments by position
   * mixed with re-picked solids. An emptied list drops the chain outright; a
   * statement that never had one stays chain-less the same way.
   */
  editRefs(): ScopeTargetRef[] {
    return this.choices.map(choice => choice.kind === 'keep'
      ? { kind: 'verbatim' as const, sourceIndex: choice.sourceIndex }
      : {
        kind: 'feature' as const,
        filePath: choice.option.filePath,
        line: choice.option.line,
        column: choice.option.column,
      });
  }
}
