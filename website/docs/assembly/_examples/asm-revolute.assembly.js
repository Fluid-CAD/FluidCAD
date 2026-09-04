import { assembly, insert, mate } from 'fluidcad/core';
import { plate } from './asm-plate.part.js';
import { lever } from './asm-lever.part.js';
import { pin } from './asm-pin.part.js';

export const leverAssembly = assembly('lever-assembly', () => {
    const base = insert(plate).grounded();
    const arm = insert(lever).translate(0, 0, 40);
    const pivotPin = insert(pin).translate(0, 0, 70);

    // highlight-start
    // Revolute leaves one degree of freedom: rotation about the shared Z.
    // The lever's pivot frame lands on the plate's bore frame, so the lever
    // lies on the plate and swings about the bore. .rotate() sets the rest
    // angle and .limits() bounds the swing, both in degrees.
    mate('revolute', base.connectors.bore, arm.connectors.pivot).rotate(30).limits(-45, 45);
    // highlight-end

    // The pin is fastened to the lever, head seated over the hole — it
    // swings with the lever.
    mate('fastened', arm.connectors.pinSeat, pivotPin.connectors.head);
});
