import { part1 } from './crank-shaft.part.js';
import { replicate, connector, origin,mate, insert } from 'fluidcad/core';
import { pistonAssembly } from './piston.assembly.js';

const part11 = insert(part1).translate(0, 285.44472, 0);

const origin1 = connector('origin', [0, 0, 0]).rotate('x', -90);

const c11 = connector('c1', [0, 156, 157.2]);

const c21 = connector('c2', [0, 156+114, 157.2]);

const c3 = connector('c3', [0, 156+(114*2), 157.2]);

const c4 = connector('c4', [0, 156+(114*3), 157.2]);

mate('revolute', part11.connectors.c1, origin1);

const pistonAssembly1 = insert(pistonAssembly);

mate('revolute', pistonAssembly1.parts.connectingRod1.connectors.c2, part11.connectors.c2).flip();
mate('slider', c11, pistonAssembly1.parts.piston21.connectors.c2);
replicate(pistonAssembly1, [part11.connectors.c2, c11], [
  [part11.connectors.c3, c21],
  [part11.connectors.c4, c3],
  [part11.connectors.c5, c4],
]);

