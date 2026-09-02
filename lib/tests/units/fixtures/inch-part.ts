// A part definition that lives in its OWN fluid file, so the unit registry
// can give it a unit different from the consuming scene's. `part()` captures
// the file through the stack trace and only recognises fluid script suffixes,
// so the definition is created from a snippet run under a `.fluid.js`
// sourceURL — the trick builder-source-location.test.ts and helpers.test.ts
// use. Declare `INCH_PART_FILE` as 'in' on the registry BEFORE the
// definition materializes (before insert() / render()).

import * as core from "../../../core/index.js";
import * as filters from "../../../filters/index.js";
import * as constraints from "../../../core/constraints/index.js";
import type { PartDefinition } from "../../../features/part-definition.js";
import { testRect } from "../../helpers/profiles.js";

export const INCH_PART_FILE = "/ws/fixtures/inch-block.fluid.js";

/**
 * A `size`×`size`×`size` block spanning x∈[0,size], y∈[-size/2,size/2],
 * z∈[0,size] — in the defining file's unit — with:
 *  - its top face coloured red,
 *  - a part-owned connector 'top' at the top-face centre (size/2, 0, size),
 *  - exposures 'profile' (the reusable base sketch) and 'top' (the top face).
 * `size` is a `param('size', 1)`, so `insert(def, { size: 2 })` doubles it.
 * With `tagBottom`, the bottom face is coloured blue as a trailing statement.
 */
const SOURCE = `
  return part('InchBlock', () => {
    const size = param('size', 1);
    const s = sketch('xy', () => {
      testRect(size, size, { at: [0, -size / 2] });
    }).reusable();
    const e = extrude(size);
    color('red', e.endFaces());
    connector('top', e.endFaces());
    expose('profile', s);
    expose('top', e.endFaces());
    if (tagBottom) {
      color('blue', e.startFaces());
    }
  });
  //# sourceURL=${INCH_PART_FILE}
`;

/**
 * `tagBottom` appends one more statement (a blue bottom face) to the body —
 * a way to make two renders of the definition diverge AFTER its first
 * members, so a prefix compare matches the part only partially.
 */
export function defineInchBlock(opts: { tagBottom?: boolean } = {}): PartDefinition {
  const globals: Record<string, unknown> = {
    ...core, ...filters, ...constraints, testRect, tagBottom: opts.tagBottom === true,
  };
  const names = Object.keys(globals);
  const values = names.map(n => globals[n]);
  const fn = new Function(...names, `"use strict";\n${SOURCE}`);
  return fn(...values) as PartDefinition;
}
