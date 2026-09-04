// @screenshot skip
import { assembly, insert, mate, connector } from 'fluidcad/core';
import { plate } from './asm-plate.part.js';
import { lever } from './asm-lever.part.js';
import { pin } from './asm-pin.part.js';

// A sub-assembly: the lever with its pin. Its return value is what a
// parent reaches through `occurrence.parts`.
const pivotArm = assembly('pivot-arm', () => {
    const arm = insert(lever).grounded();       // the anchor of THIS frame
    const pivotPin = insert(pin);
    mate('fastened', arm.connectors.pinSeat, pivotPin.connectors.head);
    return { arm, pivotPin };
});

export const mechanism = assembly('mechanism', () => {
    // The plate stands on a free frame in the assembly's space rather than
    // being grounded outright: an assembly connector is a mate side that
    // belongs to no part. This one is the bench top, 10 mm up and turned
    // to face down so the plate's top frame meets it face-to-face.
    const bench = connector('bench', [0, 0, 10]).rotate('x', 180);
    const base = insert(plate);
    mate('fastened', bench, base.connectors.top);

    // The sub-assembly is inserted once and hinged onto the plate through
    // one of its parts' connectors.
    const swing = insert(pivotArm).translate(0, 0, 40);
    mate('revolute', base.connectors.bore, swing.parts.arm.connectors.pivot).rotate(-30);
});
