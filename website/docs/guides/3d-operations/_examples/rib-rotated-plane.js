// @screenshot waitForInput
import { sketch, extrude, shell, rib, fillet, repeat, plane, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("top", () => {
    const sg1 = line([-40, -40], [40, -40]);
    const sg2 = line([40, -40], [40, 40]);
    const sg3 = line([40, 40], [-40, 40]);
    const sg4 = line([-40, 40], [-40, -40]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-40, -40]);
    distance(sg1.start(), sg1.end(), 80);
    distance(sg2.start(), sg2.end(), 80);
  })

const box = extrude(30)
const s = shell(-4, box.endFaces())
fillet(2, s.internalEdges())

sketch("top", () => {
    const sg5 = line([-15, -15], [15, -15]);
    const sg6 = line([15, -15], [15, 15]);
    const sg7 = line([15, 15], [-15, 15]);
    const sg8 = line([-15, 15], [-15, -15]);
    coincident(sg5.end(), sg6.start());
    coincident(sg6.end(), sg7.start());
    coincident(sg7.end(), sg8.start());
    coincident(sg8.end(), sg5.start());
    horizontal(sg5);
    vertical(sg6);
    horizontal(sg7);
    vertical(sg8);
    fix(sg5.start(), [-15, -15]);
    distance(sg5.start(), sg5.end(), 30);
    distance(sg6.start(), sg6.end(), 30);
  });

extrude(50)

const p = plane("front", { rotateY: 45 })

sketch(p, () => {
    // rib guide: a 45° line rising from [-40, 18]
    line([-40, 18], [-25.857864, 32.142136]);
  });

const r = rib(6).parallel().extend().draft(-1);

repeat("circular", "z", {
    count: 4,
    angle: 360
}, r)
