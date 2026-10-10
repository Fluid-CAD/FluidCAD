// The package's parts together: the washer grounded, the spacer standing
// `offset` mm along x.

import { assembly, insert, param } from 'fluidcad/core';
import { washer } from '../parts/washer.part.js';
import { spacer } from '../parts/spacer.part.js';

export const stack = assembly('Stack', () => {
  const offset = param('offset', 40);
  insert(washer()).grounded();
  insert(spacer).translate(offset, 0, 0);
});
