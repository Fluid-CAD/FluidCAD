// The services and per-request fields the apply-feature endpoints and feature handlers share.

import type { Response } from 'express';
import type { FluidCadServer } from '../../fluidcad-server/index.ts';
import { FeatureEditDispatcher } from '../../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../../apply-feature-edit/index.ts';
import { ForeignPickResolver, type ForeignPickSummary } from '../foreign-exposure.ts';
import type { SketchLoc } from './locations.ts';
import { makeSynthesisOptionsForFile } from './synthesis.ts';
import { validateNewVariables } from './validate/common.ts';

/** What every endpoint of the apply-feature router shares, created once per router. */
export type ApplyFeatureServices = {
  fluidCadServer: FluidCadServer;
  dispatcher: FeatureEditDispatcher;
  synthesisOptionsForFile: ReturnType<typeof makeSynthesisOptionsForFile>;
  foreignPicks: ForeignPickResolver;
  /** Lands cross-file expose() creates through their own dispatches; answers the request itself on failure. */
  dispatchCrossFileCreates: (res: Response, creates: ApplyFeatureEditSpec[]) => Promise<boolean>;
  /** A foreign pick list as the apply-feature response carries it. */
  foreignBody: (picks: ForeignPickSummary[]) => { foreign?: { picks: ForeignPickSummary[] } };
};

/** Declarations a dialog expression field committed, as `validateNewVariables` accepts them. */
export type NewVariables = Exclude<ReturnType<typeof validateNewVariables>, { error: string }>['newVariables'];

/**
 * One POST /apply-feature request: the services plus the body fields every
 * feature branch reads. `feature`, `value`, `preview` and `selectorOverride`
 * are the raw body fields; each branch validates what it uses.
 */
export type ApplyFeatureRequestContext = ApplyFeatureServices & {
  feature: any;
  value: any;
  preview: any;
  selectorOverride: any;
  newVariables: NewVariables;
  activePartLoc: SketchLoc | null;
  /** The active part for `filePath`, or undefined when it lives in another buffer. */
  activePartFor: (filePath: string | null) => { line: number; column: number } | undefined;
};
