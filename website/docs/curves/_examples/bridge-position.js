// @screenshot hideGrid view top
import { sketch, line, bridge } from 'fluidcad/core';

const rails = sketch('xy', () => {
  const l1 = line([0, 0], [30, 0]);
  const l2 = line([50, 20], [80, 20]);
  return { l1, l2 };
});

// Position at both ends: the bridge meets the two points and nothing
// more, a straight line between them.
// highlight-next-line
const br = bridge(rails.geometries.l1.end(), rails.geometries.l2.start()).continuity('g0');
