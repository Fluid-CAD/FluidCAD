import { assembly, insert, mate, replicate } from 'fluidcad/core';
import { plate } from './asm-plate.part.js';
import { standoff } from './asm-standoff.part.js';

export const standoffs = assembly('standoffs', () => {
    const base = insert(plate).grounded();

    // The seed: one standoff fastened onto the first mounting hole.
    const first = insert(standoff);
    mate('fastened', base.connectors.hole1, first.connectors.foot);

    // highlight-start
    // replicate() re-inserts the seed once per row and re-targets its
    // mates. The second argument lists the seed's OUTER mate sides that
    // change per copy (one column: the plate connector); each row gives
    // that column's replacement for one replica. Replicas take the seed's
    // name with a suffix — "Standoff (2)", "Standoff (3)", … — and are
    // ordinary instances from here on.
    replicate(first, [base.connectors.hole1], [
        [base.connectors.hole2],
        [base.connectors.hole3],
        [base.connectors.hole4],
    ]);
    // highlight-end
});
