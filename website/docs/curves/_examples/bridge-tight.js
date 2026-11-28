// @screenshot hideGrid view top
import { sketch, line, bridge } from 'fluidcad/core';

const rails = sketch('xy', () => {
  const l1 = line([0, 0], [30, 0]);
  const l2 = line([50, 20], [80, 20]);
  return { l1, l2 };
});

// Magnitude 0.5 at each end: the bridge turns soon after it leaves a
// rail, staying close to the straight line between the two points.
// highlight-next-line
const br = bridge(rails.geometries.l1.end(), rails.geometries.l2.start()).startMagnitude(0.5).endMagnitude(0.5);
