import { mate, insert, assembly } from 'fluidcad/core';
import { part1, connectingRod } from './connecting-rod.part.js';
import { piston as piston2 } from './piston.part.js';
import { pistonPin } from './piston-pin.part.js';
import { pistonRing } from './piston-ring.part.js';

export const pistonAssembly = assembly('piston', () => {
    const connectingRod1 = insert(connectingRod).grounded();
    const part11 = insert(part1).translate(0, 0, -97.673428);
    const piston21 = insert(piston2).translate(188.970989, 0, 0);
    const pistonPin1 = insert(pistonPin).translate(-194.494654, 0, 0);
    const pistonRing1 = insert(pistonRing).translate(0, 0, 62.720889);
    const pistonRing2 = insert(pistonRing).translate(0, 0, 27.853339);
    const pistonRing3 = insert(pistonRing).translate(120.996748, 0, 0);

    mate('fastened', part11.connectors.c1, connectingRod1.connectors.c3).flip();
    mate('fastened', pistonRing1.connectors.c1, piston21.connectors.c3);
    mate('fastened', pistonRing2.connectors.c1, piston21.connectors.c5);
    mate('fastened', pistonRing3.connectors.c1, piston21.connectors.c4);
    mate('fastened', pistonPin1.connectors.c1, connectingRod1.connectors.c1);
    mate('revolute', piston21.connectors.c1, pistonPin1.connectors.c1);
    return { connectingRod1, piston21 };
});
