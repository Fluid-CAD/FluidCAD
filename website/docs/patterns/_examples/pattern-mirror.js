import { chamfer, cut, extrude, fillet, plane, repeat, select, sketch } from 'fluidcad/core';
import { edge, } from 'fluidcad/filters';
import { circle, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch(plane("xy"), () => {
    const sg1 = line([-100, -50], [100, -50]);
    const sg2 = line([100, -50], [100, 50]);
    const sg3 = line([100, 50], [-100, 50]);
    const sg4 = line([-100, 50], [-100, -50]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-100, -50]);
    distance(sg1.start(), sg1.end(), 200);
    distance(sg2.start(), sg2.end(), 100);
  })

const e1 = extrude(20)

sketch(e1.endFaces(), () => {
    const sg5 = line([80, 30], [100, 30]);
    const sg6 = line([100, 30], [100, 50]);
    const sg7 = line([100, 50], [80, 50]);
    const sg8 = line([80, 50], [80, 30]);
    coincident(sg5.end(), sg6.start());
    coincident(sg6.end(), sg7.start());
    coincident(sg7.end(), sg8.start());
    coincident(sg8.end(), sg5.start());
    horizontal(sg5);
    vertical(sg6);
    horizontal(sg7);
    vertical(sg8);
    fix(sg5.start(), [80, 30]);
    distance(sg5.start(), sg5.end(), 20);
    distance(sg6.start(), sg6.end(), 20);
  })

cut()

sketch(e1.endFaces(), () => {
    const sg9 = line([-100, -50], [-15, -50]);
    const sg10 = line([-15, -50], [-15, -30]);
    const sg11 = line([-15, -30], [-100, -30]);
    const sg12 = line([-100, -30], [-100, -50]);
    coincident(sg9.end(), sg10.start());
    coincident(sg10.end(), sg11.start());
    coincident(sg11.end(), sg12.start());
    coincident(sg12.end(), sg9.start());
    horizontal(sg9);
    vertical(sg10);
    horizontal(sg11);
    vertical(sg12);
    fix(sg9.start(), [-100, -50]);
    distance(sg9.start(), sg9.end(), 85);
    distance(sg10.start(), sg10.end(), 20);
  })

const e2 = extrude(50);

sketch(e2.sideFaces(3), () => {
    circle([-58, 42.5], 30);
  })

const c1 = cut(20)
select(edge().onPlane("top", 20+50).parallelTo("yz"))

chamfer(15)
select(edge().onPlane("top", 20).onPlane("yz", -15))

const f2 = fillet(10)

// highlight-start
// Re-apply the wall extrude, the hole cut and the fillet on the far side of the
// front plane. The chamfer is not passed, so it stays one-sided.
repeat("mirror", "front", e2, c1, f2);
// highlight-end
