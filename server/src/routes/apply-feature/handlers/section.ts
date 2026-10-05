// POST /apply-feature, the section create branch.

import type { Request, Response } from 'express';
import {
  renderRepeatPlaneExpr,
  renderSectionStatement,
  type ApplyFeatureEditSpec,
  type RepeatPlaneSpec,
  type SectionEditOptions,
} from '../../../apply-feature-edit/index.ts';
import type { Pick } from '../picks.ts';
import { allocateProducerVars, makePickSynthesizer, makeProducerMerger } from '../synthesis.ts';
import { validateSection } from '../validate/section.ts';
import type { ApplyFeatureRequestContext } from '../context.ts';

// A section names one plane — a standard origin plane, an existing plane
// feature, or a picked face synthesized into `plane(<selector>)` — and
// carries its offset and flip; nothing else. A standard-plane section
// appends at the end of the file; a plane feature or a picked face lands
// after its producer.
export async function handleSection(ctx: ApplyFeatureRequestContext, req: Request, res: Response): Promise<void> {
  const { fluidCadServer, dispatcher, preview, newVariables } = ctx;
  const request = validateSection(req.body);
  if ('error' in request) {
    res.status(400).json({ error: request.error });
    return;
  }
  try {
    const code = fluidCadServer.getCurrentCode();
    const filePath = request.filePath;
    const { producers, merge: mergeProducer } = makeProducerMerger();
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const imports = new Set<string>();

    const synthesizePick = makePickSynthesizer({
      res, fluidCadServer, code, filePath, mergeProducer, parts, imports,
    });
    const synthesizeFace = (pick: Pick): Promise<number | null> =>
      synthesizePick(pick, 'plane', {
        multi: 'the section plane must be a single face selection',
        crossFile: 'the section face comes from a different file',
      });

    let plane: RepeatPlaneSpec;
    const input = request.plane;
    if (input.kind === 'standard') {
      plane = { kind: 'standard', plane: input.plane };
    } else if (input.kind === 'plane') {
      plane = {
        kind: 'plane',
        producer: mergeProducer({
          line: input.loc.line, column: input.loc.column,
          featureType: 'plane', nameHint: 'p', bind: true,
        }),
      };
    } else {
      const part = await synthesizeFace(input.pick);
      if (part === null) {
        return;
      }
      plane = { kind: 'selector', part };
    }

    const options: SectionEditOptions = { name: request.name, plane, offset: request.offset, flip: request.flip };
    const producerVars = await allocateProducerVars(producers, code);
    const statement = renderSectionStatement(options, renderRepeatPlaneExpr(plane, parts, i => producerVars[i]));
    if (preview === true) {
      res.json({ success: true, preview: statement });
      return;
    }
    await dispatcher.dispatch(res, {
      feature: 'section',
      section: options,
      filePath,
      producers,
      parts,
      imports: [...imports],
      newVariables,
    }, { success: true, preview: statement });
  } catch (err: any) {
    res.status(500).json({ success: false, reason: err?.message ?? String(err) });
  }
}
