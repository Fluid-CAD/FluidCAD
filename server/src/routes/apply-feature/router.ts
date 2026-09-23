// The apply-feature router: builds the shared services and mounts every endpoint group.

import { Router, type Response } from 'express';
import type { FluidCadServer } from '../../fluidcad-server.ts';
import { FeatureEditDispatcher, type EditDispatcherOptions } from '../../edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from '../../apply-feature-edit/index.ts';
import { ForeignPickResolver, type ForeignPickSummary } from '../foreign-exposure.ts';
import { makeSynthesisOptionsForFile } from './synthesis.ts';
import { registerSelectionEndpoints } from './endpoints/selection.ts';
import { registerSketchEndpoints } from './endpoints/sketch.ts';
import { registerCodeEndpoints } from './endpoints/code.ts';
import { registerApplyFeatureEndpoint } from './dispatch.ts';
import type { ApplyFeatureServices } from './context.ts';

export type ApplyFeatureRouterOptions = EditDispatcherOptions & {
  /**
   * The dispatcher to send edit specs through. Pass the process-wide one so
   * every source-writing router shares its ack registry; omitted, the router
   * builds its own from the remaining options (tests, standalone use).
   */
  dispatcher?: FeatureEditDispatcher;
};

export function createApplyFeatureRouter(
  fluidCadServer: FluidCadServer,
  sendToExtension: (msg: any) => boolean | void,
  options: ApplyFeatureRouterOptions = {},
): Router {
  const router = Router();
  const dispatcher = options.dispatcher
    ?? new FeatureEditDispatcher(fluidCadServer, sendToExtension, options);

  const synthesisOptionsForFile = makeSynthesisOptionsForFile(fluidCadServer);
  const foreignPicks = new ForeignPickResolver(fluidCadServer, synthesisOptionsForFile);

  /**
   * Land the cross-file half of a find-or-create before the consumer
   * statement: each donor-file `expose()` rides its own dispatch. Answers the
   * request itself on failure and reports whether the caller may go on.
   */
  const dispatchCrossFileCreates = async (res: Response, creates: ApplyFeatureEditSpec[]): Promise<boolean> => {
    for (const create of creates) {
      const sent = await dispatcher.send(create);
      if (sent.error) {
        res.status(422).json({ success: false, reason: sent.error });
        return false;
      }
    }
    return true;
  };

  /** A foreign pick list as the apply-feature response carries it. */
  const foreignBody = (picks: ForeignPickSummary[]): { foreign?: { picks: ForeignPickSummary[] } } =>
    picks.length > 0 ? { foreign: { picks } } : {};

  const services: ApplyFeatureServices = {
    fluidCadServer, dispatcher, synthesisOptionsForFile, foreignPicks, dispatchCrossFileCreates, foreignBody,
  };
  registerSelectionEndpoints(router, services);
  registerApplyFeatureEndpoint(router, services);
  registerSketchEndpoints(router, services);
  registerCodeEndpoints(router, services);
  return router;
}
