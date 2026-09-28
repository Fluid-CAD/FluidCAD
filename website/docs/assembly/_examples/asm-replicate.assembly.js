import { assembly, insert, mate, replicate } from 'fluidcad/core';
import { plate } from './asm-plate.part.js';
import { standoff } from './asm-standoff.part.js';

export const standoffs = assembly('standoffs', () => {
    const base = insert(plate).grounded();

    // The seed: one standoff fastened onto the first mounting hole.
    const first = insert(standoff);
    mate('fastened', base.connectors.hole, first.connectors.foot);

    // highlight-start
    // replicate() re-inserts the seed once per row and re-targets its
    // mates. The second argument lists the seed's OUTER mate sides that
    // change per copy (one column: the plate connector); each row gives
    // that column's replacement for one replica. The plate copies its
    // `hole` connector onto the other three holes, so each row names one
    // of those copies: hole.instance(1) is copy 1 of `hole`. Replicas take
    // the seed's name with a suffix — "Standoff (2)", "Standoff (3)", … —
    // and are ordinary instances from here on.
    replicate(first, [base.connectors.hole], [
        [base.connectors.hole.instance(1)],
        [base.connectors.hole.instance(2)],
        [base.connectors.hole.instance(3)],
    ]);
    // highlight-end
});
