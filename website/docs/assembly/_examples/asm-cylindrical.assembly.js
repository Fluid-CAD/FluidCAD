import { assembly, insert, mate } from 'fluidcad/core';
import { cylinder } from './asm-cylinder.part.js';
import { piston } from './asm-piston.part.js';

export const actuator = assembly('actuator', () => {
    const body = insert(cylinder).grounded();
    const ram = insert(piston).translate(0, 0, 80);

    // highlight-start
    // Cylindrical = revolute + slider: the piston can spin about the bore
    // axis AND travel along it. Only a Z offset is allowed, since the two
    // frames share their axis — here it puts the skirt 20 mm down the bore,
    // so the piston stands half in, half out.
    mate('cylindrical', body.connectors.bore, ram.connectors.skirt).offset(0, 0, -20);
    // highlight-end
});
