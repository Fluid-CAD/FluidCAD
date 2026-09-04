import { assembly, insert, mate } from 'fluidcad/core';
import { plate } from './asm-plate.part.js';
import { roller } from './asm-roller.part.js';

export const rollerStand = assembly('roller-stand', () => {
    const deck = insert(plate).grounded();
    const wheel = insert(roller).translate(-20, 0, 30);

    // highlight-start
    // Tangent is written on exposed geometry, not connectors: the roller's
    // tread touches the plate's top face. The contact side comes from the
    // faces themselves, so there is nothing to flip, rotate or offset.
    mate('tangent', wheel.features.tread, deck.features.deck);
    // highlight-end
});
