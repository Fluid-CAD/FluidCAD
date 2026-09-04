import { assembly, insert, mate } from 'fluidcad/core';
import { plate } from './asm-plate.part.js';
import { clamp } from './asm-clamp.part.js';

export const workTable = assembly('work-table', () => {
    const table = insert(plate).grounded();
    const block = insert(clamp).translate(-15, 8, 40).rotate('z', 20);

    // highlight-start
    // Planar keeps the two faces in contact and leaves three degrees of
    // freedom: slide in X, slide in Y, spin about Z. The block keeps the
    // position and spin its insert pose gave it; drag it in the viewport
    // and it stays flat on the plate.
    mate('planar', table.connectors.top, block.connectors.bottom);
    // highlight-end
});
