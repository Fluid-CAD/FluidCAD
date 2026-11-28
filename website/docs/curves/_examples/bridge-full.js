// @screenshot hideGrid view top
import { sketch, line, bridge } from 'fluidcad/core';

const rails = sketch('xy', () => {
  const l1 = line([0, 0], [30, 0]);
  const l2 = line([50, 20], [80, 20]);
  return { l1, l2 };
});

// Magnitude 2 at each end: the bridge runs on along each rail for longer
// before it turns, and swings round in a fuller S.
// highlight-next-line
const br = bridge(rails.geometries.l1.end(), rails.geometries.l2.start()).startMagnitude(2).endMagnitude(2);
