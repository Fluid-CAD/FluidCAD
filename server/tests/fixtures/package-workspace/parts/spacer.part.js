// A round spacer, authored in inches whatever the package's unit is.

import { cylinder, param, part, unit } from 'fluidcad/core';
import { SPACER_LENGTH, SPACER_RADIUS } from '../helpers/sizes.js';

unit('in');

export const spacer = part('Spacer', () => {
  const length = param('Length', SPACER_LENGTH, 'number', { min: 0.1 });
  cylinder(SPACER_RADIUS, length);
});
