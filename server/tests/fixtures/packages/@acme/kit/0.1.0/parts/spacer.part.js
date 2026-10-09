// A round spacer. It declares no unit(): its numbers are in the package's
// unit, the `unit` of the fluidcad.json at the package root (inches). Its
// material is the package's own (that fluidcad.json's `materials`), whatever
// the project that inserts it defines.

import { cylinder, param, part } from 'fluidcad/core';
import { SPACER_LENGTH, SPACER_RADIUS } from '../helpers/sizes.js';

export const spacer = part('Spacer', () => {
  const length = param('Length', SPACER_LENGTH, 'number', { min: 0.1 });
  cylinder(SPACER_RADIUS, length);
}).material('acme-pom');
