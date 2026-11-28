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

// The block's far top corner is written as the end of the upright edge
// through it. Tangent there follows that edge: the bridge arrives heading
// into the edge, coming straight down onto the corner as if to run on
// down the edge.
// highlight-next-line
const br = bridge(rail.geometries.l.end(), block.sideEdges(edge().farthest('x').farthest('y')).end());
