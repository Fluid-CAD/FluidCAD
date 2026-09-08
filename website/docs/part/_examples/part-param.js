import { part, param, sketch, line, circle, extrude, chamfer } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A parametric mounting plate: a rectangle with a clearance hole near each
// corner, extruded to a thickness. Every param() is a control in the
// Parameters panel; an assembly sets them per instance —
// insert(plate, { Width: 120, Hole: 6.6 }).
export const plate = part('Plate', () => {
    // highlight-start
    // Number fields with bounds. The label is the key an override uses.
    const width = param('Width', 80, 'number', { min: 40, max: 200, step: 5, group: 'Size' });
    const depth = param('Depth', 50, 'number', { min: 30, max: 150, step: 5, group: 'Size' });
    // A slider — the panel shows a range control instead of a field.
    const thickness = param('Thickness', 6, 'slider', { min: 3, max: 15, step: 0.5, group: 'Size' });
    // A select with fixed choices: the value is the option's `value`, here
    // the clearance diameter of the screw.
    const hole = param('Hole', 5.5, 'select', {
        options: [
            { label: 'M4', value: 4.5 },
            { label: 'M5', value: 5.5 },
            { label: 'M6', value: 6.6 },
        ],
        description: 'Clearance hole for the mounting screw',
    });
    // A checkbox turns a feature on or off.
    const chamfered = param('Chamfer top edges', true, 'checkbox');
    // highlight-end

    sketch('xy', () => {
        // The outline's guesses use the parameters directly …
        const b = line([-width / 2, -depth / 2], [width / 2, -depth / 2]);
        const r = line([width / 2, -depth / 2], [width / 2, depth / 2]);
        const t = line([width / 2, depth / 2], [-width / 2, depth / 2]);
        const l = line([-width / 2, depth / 2], [-width / 2, -depth / 2]);
        coincident(b.end(), r.start());
        coincident(r.end(), t.start());
        coincident(t.end(), l.start());
        coincident(l.end(), b.start());
        horizontal(b);
        horizontal(t);
        vertical(r);
        vertical(l);
        fix(b.start(), [-width / 2, -depth / 2]);
        // … and so do the dimensions: change Width in the panel and the
        // solver re-sizes the outline.
        distance(b.start(), b.end(), width);
        distance(r.start(), r.end(), depth);
        // One hole inset 8 mm from each corner.
        const inset = 8;
        for (const sx of [-1, 1]) {
            for (const sy of [-1, 1]) {
                circle([sx * (width / 2 - inset), sy * (depth / 2 - inset)], hole / 2);
            }
        }
    });
    const e = extrude(thickness);
    if (chamfered) {
        chamfer(1, e.endEdges());
    }
});
