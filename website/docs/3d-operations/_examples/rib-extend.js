// @screenshot view iso-ftr
import { sketch, extrude, shell, rib, fillet, line } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("top", () => {
    const sg1 = line([-50, -25], [50, -25]);
    const sg2 = line([50, -25], [50, 25]);
    const sg3 = line([50, 25], [-50, 25]);
    const sg4 = line([-50, 25], [-50, -25]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-50, -25]);
    distance(sg1.start(), sg1.end(), 100);
    distance(sg2.start(), sg2.end(), 50);
  })

const box = extrude(30)
const s = shell(-4, box.endFaces())
fillet(2, s.internalEdges())

sketch(box.endFaces(), () => {
    const sg5 = line([-50, 0], [-20, 0]);
    horizontal(sg5);
  });

rib(5).extend().draft(2);
