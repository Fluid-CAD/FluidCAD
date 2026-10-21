// @screenshot hideGrid view iso-ftr
import { part, param, configurations, sketch, line, point, plane, extrude, hole } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// An angle bracket in three screw sizes. The param() calls are the part's
// parameters; each configurations() row names a set of their values, and
// Default is the param() literals — the M6 bracket.
export const bracket = part('Bracket', () => {
    // highlight-start
    // The first statement of the body, before any param(). One entry per
    // configuration; a row lists only the labels it changes, and a label it
    // leaves out keeps its param() literal. The return value is the name of
    // the row being built — 'Default' when none is.
    const configuration = configurations({
        M8: { Screw: 'M8', Width: 50, Leg: 50, Thickness: 5 },
        M10: { Screw: 'M10', Width: 60, Leg: 60, Thickness: 6, Gusset: true },
    });
    // highlight-end

    // The parameters, declared once with their controls and bounds. The
    // screw is a select whose values are fastener sizes, so hole() reads it
    // as is.
    const screw = param('Screw', 'M6', 'select', {
        options: [
            { label: 'M6', value: 'M6' },
            { label: 'M8', value: 'M8' },
            { label: 'M10', value: 'M10' },
        ],
    });
    const width = param('Width', 40, 'number', { min: 30, max: 120, step: 5 });
    const leg = param('Leg', 40, 'number', { min: 30, max: 120, step: 5 });
    const thickness = param('Thickness', 4, 'number', { min: 3, max: 10, step: 0.5 });
    const gusset = param('Gusset', false, 'checkbox');

    // The L profile on the side plane: two legs of `leg`, both `thickness`
    // thick, extruded `width` across, centred on the origin.
    sketch('yz', () => {
        const a = line([0, 0], [-leg, 0]);
        const b = line([-leg, 0], [-leg, thickness]);
        const c = line([-leg, thickness], [-thickness, thickness]);
        const d = line([-thickness, thickness], [-thickness, leg]);
        const e = line([-thickness, leg], [0, leg]);
        const f = line([0, leg], [0, 0]);
        coincident(a.end(), b.start());
        coincident(b.end(), c.start());
        coincident(c.end(), d.start());
        coincident(d.end(), e.start());
        coincident(e.end(), f.start());
        coincident(f.end(), a.start());
        horizontal(a);
        vertical(b);
        horizontal(c);
        vertical(d);
        horizontal(e);
        vertical(f);
        fix(a.start(), [0, 0]);
        distance(a.start(), a.end(), leg);
        distance(f.start(), f.end(), leg);
        distance(b.start(), b.end(), thickness);
        distance(e.start(), e.end(), thickness);
    });
    extrude(width).symmetric();

    // A checkbox turns the gusset on. Only the M10 row sets it, so only the
    // M10 bracket has one: what a configuration "does" is ordinary code
    // reading a parameter.
    if (gusset) {
        sketch('yz', () => {
            const a = line([-thickness, thickness], [-leg * 0.6, thickness]);
            const b = line([-leg * 0.6, thickness], [-thickness, leg * 0.6]);
            const c = line([-thickness, leg * 0.6], [-thickness, thickness]);
            coincident(a.end(), b.start());
            coincident(b.end(), c.start());
            coincident(c.end(), a.start());
            horizontal(a);
            vertical(c);
            fix(a.start(), [-thickness, thickness]);
            distance(a.start(), a.end(), leg * 0.6 - thickness);
            distance(c.start(), c.end(), leg * 0.6 - thickness);
        });
        extrude(thickness).symmetric();
    }

    // Two clearance holes in each leg, a quarter of the width either side
    // of the middle, placed by points on the legs' inner faces. hole()
    // takes the screw size and cuts its clearance diameter, so every row
    // gets the right holes without listing them.
    const flat = sketch(plane('xy', { offset: thickness }), () => {
        const p1 = point([-width / 4, -(leg + thickness) / 2]);
        const p2 = point([width / 4, -(leg + thickness) / 2]);
        fix(p1, [-width / 4, -(leg + thickness) / 2]);
        fix(p2, [width / 4, -(leg + thickness) / 2]);
        return { p1, p2 };
    });
    hole(screw, flat.geometries.p1, flat.geometries.p2);

    const upright = sketch(plane('xz', { offset: thickness }), () => {
        const p1 = point([-width / 4, (leg + thickness) / 2]);
        const p2 = point([width / 4, (leg + thickness) / 2]);
        fix(p1, [-width / 4, (leg + thickness) / 2]);
        fix(p2, [width / 4, (leg + thickness) / 2]);
        return { p1, p2 };
    });
    hole(screw, upright.geometries.p1, upright.geometries.p2);
});
