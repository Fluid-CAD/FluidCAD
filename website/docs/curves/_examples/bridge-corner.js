// @screenshot hideGrid
import { sketch, extrude, line, plane, bridge } from 'fluidcad/core';
import { rect } from 'fluidcad/shapes';
import { edge } from 'fluidcad/filters';

// A block 40 × 20, 10 tall.
sketch('xy', () => {
  rect([0, 0], 40, 20);
});
const block = extrude(10);

// A rail in the air, to the left of the block.
const rail = sketch(plane('xy', 25), () => {
  const l = line([-40, 10], [-15, 10]);
  return { l };
});

// The same corner met at its position only: 'g0' at the end, while the
// start still leaves the rail along it. The dialog writes this when you
// pick the corner itself.
// highlight-next-line
const br = bridge(rail.geometries.l.end(), block.sideEdges(edge().farthest('x').farthest('y')).end()).continuity('g1', 'g0');
