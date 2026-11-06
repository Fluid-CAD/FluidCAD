// A plain washer disc, exported as a factory: a model inserts it as
// `insert(washer())`, and pack builds it by calling it with no arguments.

import { cylinder, part } from 'fluidcad/core';

export function washer(diameter = 12, thickness = 2) {
  return part('Washer', () => {
    cylinder(diameter / 2, thickness);
  });
}
