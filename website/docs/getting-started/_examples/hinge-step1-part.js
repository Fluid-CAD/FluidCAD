// @screenshot skip
import { part, sketch, line, circle, extrude, cut, repeat, fillet, connector } from 'fluidcad/core';
import { coincident, horizontal, vertical, distance, diameter, fix, concentric } from 'fluidcad/constraints';
import { edge } from 'fluidcad/filters';

// The part container: everything inside the callback belongs to the
// "Fixed leaf". Exporting it is what lets an assembly insert() it later.
export const fixedLeaf = part('Fixed leaf', () => {
});
