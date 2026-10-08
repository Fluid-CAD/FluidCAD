import { assembly, insert, mate, relation, connector } from 'fluidcad/core';
import { plate } from './asm-plate.part.js';
import { gear } from './asm-gear.part.js';

export const gearTrain = assembly('gear-train', () => {
    const base = insert(plate).grounded();
    // A 12-tooth pinion driving a 24-tooth wheel, 54 mm apart (the sum of
    // their pitch radii, 18 + 36).
    const pinion = insert(gear, { teeth: 12 }).translate(-27, 0, 10);
    const wheel = insert(gear, { teeth: 24 }).translate(27, 0, 10);

    // Two axle frames on the plate's top face, as assembly connectors.
    const axle1 = connector('axle1', [-27, 0, 10]);
    const axle2 = connector('axle2', [27, 0, 10]);
    const pinionAxle = mate('revolute', axle1, pinion.connectors.bore);
    const wheelAxle = mate('revolute', axle2, wheel.connectors.bore);

    // highlight-start
    // The gear relation: the wheel makes half a turn per pinion turn, and
    // turns the other way — external gears on parallel axes counter-rotate.
    relation('gear', pinionAxle, wheelAxle, 0.5).reverse();
    // highlight-end
});
