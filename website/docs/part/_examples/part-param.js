import { part, param, sketch, line, circle, extrude, fillet } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A parametric aluminium extrusion: a square profile with rounded corners
// and a central bore, extruded to length. Every param() shows up in the
// Parameters panel; an assembly overrides them per instance —
// insert(extrusion, { Length: 380 }).
export const extrusion = part('Extrusion', () => {
    // highlight-start
    // A select with fixed choices: the profile series. The value is the
    // option's `value`, here the side length in mm.
    const size = param('Series', 20, 'select', {
        options: [
            { label: '20 × 20', value: 20 },
            { label: '30 × 30', value: 30 },
            { label: '40 × 40', value: 40 },
        ],
        group: 'Profile',
    });
    // A slider — the panel shows a range control instead of a field.
    const bore = param('Bore', 4.2, 'slider', { min: 3, max: 8, step: 0.1, group: 'Profile' });
    // A number field with bounds. The label is the key an override uses.
    const length = param('Length', 80, 'number', { min: 20, max: 2000, step: 10 });
    // A checkbox drives a feature on or off.
    const rounded = param('Rounded corners', true, 'checkbox', {
        description: 'Round the four outer corners with a 2 mm radius',
    });
    // highlight-end

    sketch('xy', () => {
        // The square's guesses use the parameter directly …
        const b = line([-size / 2, -size / 2], [size / 2, -size / 2]);
        const r = line([size / 2, -size / 2], [size / 2, size / 2]);
        const t = line([size / 2, size / 2], [-size / 2, size / 2]);
        const l = line([-size / 2, size / 2], [-size / 2, -size / 2]);
        coincident(b.end(), r.start());
        coincident(r.end(), t.start());
        coincident(t.end(), l.start());
        coincident(l.end(), b.start());
        horizontal(b);
        horizontal(t);
        vertical(r);
        vertical(l);
        fix(b.start(), [-size / 2, -size / 2]);
        // … and so do the dimensions: change Series in the panel and the
        // solver re-sizes the profile.
        distance(b.start(), b.end(), size);
        distance(r.start(), r.end(), size);
        if (rounded) {
            fillet(2, b, r, t, l);
        }
        // The central bore for a self-tapping screw.
        circle([0, 0], bore);
    });
    extrude(length);
});
