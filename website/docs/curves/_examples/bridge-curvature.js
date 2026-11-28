// @screenshot hideGrid view top
import { sketch, line, bridge } from 'fluidcad/core';

const rails = sketch('xy', () => {
  const l1 = line([0, 0], [30, 0]);
  const l2 = line([50, 20], [80, 20]);
  return { l1, l2 };
});

// Curvature at both ends: the bridge carries on each rail's bend as well
// as its direction. A line has no bend, so the bridge leaves it with none
// and turns later than a tangent bridge does.
// highlight-next-line
const br = bridge(rails.geometries.l1.end(), rails.geometries.l2.start()).continuity('g2');
