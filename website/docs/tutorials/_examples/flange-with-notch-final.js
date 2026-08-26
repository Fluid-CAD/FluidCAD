// @screenshot waitForInput
import { arc, circle, cut, extrude, line, mirror, plane, remove, sketch, xAxis } from "fluidcad/core";
import { coincident, concentric, diameter, distance, equal, fix, horizontal, symmetric, tangent, vertical } from "fluidcad/constraints";

const baseSketch = sketch("xy", () => {
    const c1 = circle([0, 0], 42).reusable();
    const c2 = circle([0, 0], 70).reusable();
    const c3 = circle([50, 0], 10);
    const c4 = circle([50, 0], 32).guide();
    const l1 = line([13.3, 32.374527], [56.08, 14.799784]);
    const a = arc([56.08, -14.799784], [56.08, 14.799784], [50, 0]);

    fix(c1.center(), [0, 0]);
    concentric(c1, c2);
    diameter(c1, 42);
    diameter(c2, 70);
    fix(c3.center(), [50, 0]);
    concentric(c3, c4);
    diameter(c3, 10);
    diameter(c4, 32);
    tangent(l1, c2);
    tangent(l1, c4);
    coincident(l1.start(), c2);
    coincident(l1.end(), c4);
    concentric(a, c4);
    equal(a, c4);
    coincident(a.end(), l1.end());
    symmetric(a.start(), l1.end(), xAxis());

    const m = mirror("x", l1);
    mirror("y", l1, m, a, c3);
})

const base = extrude(12)

// middle pipe — reuses the 42 and 70 circles still alive in the base sketch
extrude(46);
remove(baseSketch);

// notch
sketch(plane("xy", 46), () => {
    const nb = line([-15, -35], [15, -35]);
    const nr = line([15, -35], [15, 35]);
    const nt = line([15, 35], [-15, 35]);
    const nl = line([-15, 35], [-15, -35]);

    coincident(nb.end(), nr.start());
    coincident(nr.end(), nt.start());
    coincident(nt.end(), nl.start());
    coincident(nl.end(), nb.start());
    horizontal(nb);
    vertical(nr);
    horizontal(nt);
    vertical(nl);
    fix(nb.start(), [-15, -35]);
    distance(nb.start(), nb.end(), 30);
    distance(nr.start(), nr.end(), 70);
})
cut(8)

// counter bores
sketch(base.endFaces(), () => {
    circle([50, 0], 20);
    mirror("y")
  });

cut(4)
