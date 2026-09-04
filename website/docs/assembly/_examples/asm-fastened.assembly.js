import { assembly, insert, mate } from 'fluidcad/core';
import { plate } from './asm-plate.part.js';
import { cover } from './asm-cover.part.js';

export const coverAssembly = assembly('cover-assembly', () => {
    // The base plate is the anchor: grounded parts never move.
    const base = insert(plate).grounded();
    // The cover starts wherever it is inserted; the mate places it.
    const lid = insert(cover).translate(0, 0, 40);

    // highlight-start
    // Fastened removes every degree of freedom. The cover's underside frame
    // is glued face-to-face onto the plate's top frame: origins coincide,
    // the two Z axes point at each other, so the cover lies on the plate
    // with its holes over the plate's holes.
    mate('fastened', base.connectors.top, lid.connectors.bottom);
    // highlight-end
});
