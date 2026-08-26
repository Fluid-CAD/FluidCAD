// @screenshot waitForInput
import { circle, cut, extrude, fillet, plane, repeat, rib, select, shell, sketch, line } from "fluidcad/core";
import { edge, face } from "fluidcad/filters";
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch(plane("top", 1.50), () => {
    const sg1 = line([-3.5, -2.5], [3.5, -2.5]);
    const sg2 = line([3.5, -2.5], [3.5, 2.5]);
    const sg3 = line([3.5, 2.5], [-3.5, 2.5]);
    const sg4 = line([-3.5, 2.5], [-3.5, -2.5]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-3.5, -2.5]);
    distance(sg1.start(), sg1.end(), 7);
    distance(sg2.start(), sg2.end(), 5);
  });

const base = extrude(-1.5).draft(-8);

fillet(.750, base.sideEdges())
fillet(.50, select(edge().onPlane("top")))

shell(-.250, select(face().onPlane("top", 1.5)))

sketch(plane("top", 2), () => {
    circle([0, 0], 2);
  });

const pipeBody = extrude(-2).draft(8);

sketch(pipeBody.startFaces(), () => {
    circle([0, 0], 1.5);
  });

cut().draft(-8);
