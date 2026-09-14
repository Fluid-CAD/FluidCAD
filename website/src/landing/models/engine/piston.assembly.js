import {connectingRodCap, connectingRod } from './connecting-rod.part.js';
import {mate, insert, assembly } from 'fluidcad/core';
import { piston } from './piston.part.js';
import { pin } from './pin.part.js';
import { pistonRing } from './piston-ring.part.js';

export const pistonAssembly = assembly("Piston Assembly", () => {
  const connectingRod1 = insert(connectingRod).grounded();

const connectingRodCap1 = insert(connectingRodCap).translate(0, 0, -61.653206);

const piston1 = insert(piston).translate(0, 0, 335.45068);


const pin1 = insert(pin).translate(0, 146.112172, 0);
const pistonRing1 = insert(pistonRing).translate(-21.194154, 16.372491, 38.965323);
const pistonRing2 = insert(pistonRing).translate(0, 198.718659, 0);
const pistonRing3 = insert(pistonRing);



mate('fastened', pistonRing2.connectors.c1, piston1.connectors.c4);
mate('fastened', pistonRing1.connectors.c1, piston1.connectors.c3);
mate('fastened', pistonRing3.connectors.c1, piston1.connectors.c5);
mate('fastened', pin1.connectors.c1, piston1.connectors.c1);
mate('fastened', connectingRodCap1.connectors.c1, connectingRod1.connectors.c1).rotate(180);
mate('revolute', connectingRod1.connectors.c2, piston1.connectors.c1).flip();
return { connectingRodCap1, piston1, connectingRod1, pin1 };
})
