// @screenshot hideGrid view top
import { sketch, line, bridge } from 'fluidcad/core';

// Two rails with a gap between them, the second one 20 higher up. The
// sketch returns its lines so a statement after it can read their ends.
const rails = sketch('xy', () => {
  const l1 = line([0, 0], [30, 0]);
  const l2 = line([50, 20], [80, 20]);
  return { l1, l2 };
});

// A smooth curve from the end of l1 to the start of l2. It leaves l1
// heading the way l1 runs and arrives at l2 heading along it: tangent at
// both ends, the default. The rails are read, not used up.
// highlight-next-line
const br = bridge(rails.geometries.l1.end(), rails.geometries.l2.start());
