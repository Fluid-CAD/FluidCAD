// @screenshot skip
import { part, param, sketch, line, arc, point, circle, extrude, cut, chamfer, fillet, repeat, color, plane, connector, origin, xAxis, yAxis } from 'fluidcad/core';
import { coincident, diameter, distance, fix, radius, symmetric, vertical } from 'fluidcad/constraints';

// A spur gear: module 3, 20° pressure angle, 8 mm face width.
export const gear = part('Gear', () => {
    const teeth = param('teeth', 12, 'number', { min: 8, max: 48, step: 1 });

    // The standard proportions. The pitch circle is the one two meshing
    // gears roll on: its radius is half the module times the teeth, so two
    // gears sit (m / 2) × (z1 + z2) apart.
    const m = 3;
    const pressureAngle = 20 * Math.PI / 180;
    const pitchR = m * teeth / 2;
    const baseR = pitchR * Math.cos(pressureAngle);   // the involutes unwind from here
    const tipR = pitchR + m;                          // addendum: one module
    const rootR = pitchR - 1.25 * m;                  // dedendum: 1.25 modules
    const rootFillet = 0.3 * m;
    const backlash = 0.1;                             // tooth 0.1 mm thinner than half the pitch
    const faceWidth = 8;
    const hubD = Math.min(10 + m * teeth / 4, 2 * rootR - 4);
    const hubHeight = 6;
    const rimR = rootR - 2 * m;                       // the rim under the teeth: 2 modules deep
    const holeR = (rimR + hubD / 2) / 2;              // lightening holes, centred on the web
    const holeD = 0.6 * (rimR - hubD / 2);

    // The involute flank of a tooth gap, at roll angle t: the point
    // baseR·√(1 + t²) from the centre, at the polar angle gapHalf + t − atan t.
    // gapHalf is the gap's half-angle on the base circle, chosen so the gap is
    // half the circular pitch (π·m / 2) wide on the pitch circle, plus the
    // backlash.
    const inv = (r) => Math.tan(Math.acos(baseR / r)) - Math.acos(baseR / r);
    const gapHalf = Math.PI / (2 * teeth) - inv(pitchR) + backlash / (2 * pitchR);
    const involute = (t) => {
        const r = baseR * Math.sqrt(1 + t * t);
        const a = gapHalf + t - Math.atan(t);
        return [r * Math.cos(a), r * Math.sin(a)];
    };
    // Each flank is drawn as the circular arc through three involute points:
    // where it leaves the root run (the base circle, or just above the root
    // fillet when the base circle sits below the root), half-way, and 1 mm
    // past the tip. Over the working depth it strays under 0.07 mm from the
    // true involute.
    const startR = Math.max(baseR, rootR + 1.5 * rootFillet);
    const t0 = Math.sqrt((startR / baseR) ** 2 - 1);
    const t2 = Math.sqrt(((tipR + 1) / baseR) ** 2 - 1);
    const t1 = (t0 + t2) / 2;
    const [p0, p1, p2] = [involute(t0), involute(t1), involute(t2)];
    // Its centre lies near where the flank's middle touches the base circle.
    const centre = [baseR * Math.cos(gapHalf + t1), baseR * Math.sin(gapHalf + t1)];
    const below = ([x, y]) => [x, -y];   // the mirror image across X

    // The blank: a disc at the tip diameter, its rims chamfered — the teeth
    // keep the chamfer at their tips.
    sketch('xy', () => {
        const c = circle([0, 0], 2 * tipR);
        coincident(c.center(), origin());
        diameter(c, 2 * tipR);
    });
    const disc = extrude(faceWidth);
    chamfer(0.5, disc.startEdges(), disc.endEdges());

    // One tooth gap, centred on +X: a root arc, a radial run up each side,
    // the two flank arcs and an arc outside the tip that closes the outline.
    sketch(disc.endFaces(), () => {
        const root = arc(below(p0), p0, [0, 0]);
        const upRun = line([rootR, 1], p0);
        const upFlank = arc(p0, p2, centre);
        const outer = arc(below(p2), p2, [0, 0]);
        const downFlank = arc(below(p2), below(p0), below(centre));
        const downRun = line(below(p0), [rootR, -1]);
        const upMid = point(p1);
        const downMid = point(below(p1));
        coincident(root.center(), origin());
        radius(root, rootR);
        coincident(root.end(), upRun.start());
        coincident(upRun.end(), upFlank.start());
        coincident(upFlank.end(), outer.end());
        coincident(outer.start(), downFlank.start());
        coincident(downFlank.end(), downRun.start());
        coincident(downRun.end(), root.start());
        // The runs are radial; the flank arcs pass through their three points.
        coincident(origin(), upRun);
        coincident(origin(), downRun);
        fix(upFlank.start(), p0);
        fix(upFlank.end(), p2);
        fix(upMid, p1);
        coincident(upMid, upFlank);
        fix(downFlank.start(), below(p2));
        fix(downFlank.end(), below(p0));
        fix(downMid, below(p1));
        coincident(downMid, downFlank);
        radius(outer, tipR + 1);
        // Round the two root corners.
        fillet(rootFillet, root, upRun, downRun);
    });
    cut(faceWidth);
    // … repeated around the axis, once per tooth.
    repeat('circular', 'z', { count: teeth, angle: 360 });

    // The hub: a boss standing 6 mm proud of the top face, wider on bigger
    // gears but always inside the root circle.
    sketch('xy', () => {
        const c = circle([0, 0], hubD);
        coincident(c.center(), origin());
        diameter(c, hubD);
    });
    const hub = extrude(faceWidth + hubHeight);
    chamfer(0.5, hub.endEdges());

    // From 20 teeth up, a thinner web between the hub and the rim: a 2 mm
    // recess in the top face and six lightening holes through it.
    if (teeth >= 20) {
        sketch(disc.endFaces(), () => {
            const rim = circle([0, 0], 2 * rimR);
            const boss = circle([0, 0], hubD);
            coincident(rim.center(), origin());
            coincident(boss.center(), origin());
            diameter(rim, 2 * rimR);
            diameter(boss, hubD);
        });
        cut(2);
        sketch(disc.endFaces(), () => {
            const c = circle([holeR, 0], holeD);
            coincident(c.center(), xAxis());
            distance(origin(), c.center(), holeR);
            diameter(c, holeD);
        });
        cut();
        repeat('circular', 'z', { count: 6, angle: 360 });
    }

    // The Ø8 bore with a 2 mm keyway, cut down through the hub.
    sketch(hub.endFaces(), () => {
        const bore = arc([-1, 3.9], [1, 3.9], [0, 0]);
        const r = line([1, 3.9], [1, 5]);
        const t = line([1, 5], [-1, 5]);
        const l = line([-1, 5], [-1, 3.9]);
        coincident(bore.end(), r.start());
        coincident(r.end(), t.start());
        coincident(t.end(), l.start());
        coincident(l.end(), bore.start());
        coincident(bore.center(), origin());
        diameter(bore, 8);
        vertical(r);
        vertical(l);
        symmetric(t.start(), t.end(), yAxis());
        distance(t.start(), t.end(), 2);
        distance(origin(), t, 5);
    });
    cut();

    color('steelblue');

    // The bore frame on the underside: Z out of the bottom face, ready to
    // meet an axle frame that points up.
    connector('bore', plane('-xy'));
});
