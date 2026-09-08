// @screenshot skip
import { assembly, insert, param } from 'fluidcad/core';
import { plate } from './plate.part.js';

// A parametric sub-assembly: a column of plates. Its own param() is the
// interface a parent overrides — insert(stack, { Levels: 4 }).
const stack = assembly('stack', () => {
    const levels = param('Levels', 3, 'number', { min: 1, max: 6, step: 1 });
    insert(plate, { Width: 60, Depth: 40 }).grounded();
    for (let i = 1; i < levels; i++) {
        insert(plate, { Width: 60, Depth: 40, 'Chamfer top edges': false }).translate(0, 0, i * 20);
    }
});

export const frame = assembly('frame', () => {
    // highlight-start
    // The assembly's own parameter — shown in its Parameters panel and
    // passed on to the inserts below.
    const rail = param('Rail width', 120, 'number', { min: 80, max: 200, step: 10 });
    // Overrides are keyed by the part's labels. These two share one build.
    insert(plate, { Width: rail, Hole: 6.6 }).grounded();
    insert(plate, { Width: rail, Hole: 6.6 }).translate(0, 70, 0);
    // A different set of values is a second variant of the same part.
    insert(plate, { Width: 60, Depth: 40, Thickness: 4 }).translate(rail / 2 + 50, 35, 0);
    // The sub-assembly's parameter, overridden the same way.
    insert(stack, { Levels: 4 }).translate(-(rail / 2 + 50), 35, 0);
    // highlight-end
});
