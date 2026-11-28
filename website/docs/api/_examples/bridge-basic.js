// @screenshot hideGrid view top
import { sketch, line, bridge } from 'fluidcad/core';

const rails = sketch('xy', () => {
  const l1 = line([0, 0], [30, 0]);
  const l2 = line([50, 20], [80, 20]);
  return { l1, l2 };
});

// Outside a sketch: a smooth curve from the end of one line to the start
// of the other, tangent to both, its start a little fuller.
const br = bridge(rails.geometries.l1.end(), rails.geometries.l2.start()).startMagnitude(1.5);
