// @screenshot skip
import { origin, xAxis, yAxis, part, sketch, line, circle, extrude, cut, repeat, fillet, connector } from 'fluidcad/core';
import { coincident, horizontal, vertical, midpoint, distance, diameter, fix } from 'fluidcad/constraints';
import { edge } from 'fluidcad/filters';

// The part container: everything inside the callback belongs to the
// "Fixed leaf". Exporting it is what lets an assembly insert() it later.
export const fixedLeaf = part('Fixed leaf', () => {
});
