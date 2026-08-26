// @screenshot waitForInput
import { arc, axis, circle, copy, cut, extrude, fillet, line, project, remove,
    repeat, sketch, sweep } from "fluidcad/core";
import { coincident, concentric, diameter, distance, equal, fix, horizontal,
    radius, tangent, vertical } from "fluidcad/constraints";

const spine = sketch("front", () => {
    const riser = line([0, 0], [0, 1.5]);
    const bend = arc([0, 1.5], [1.171573, 4.328427], [4, 1.5]).cw();
    const topSegment = line([1.171573, 4.328427], [2.232233, 5.389087]);

    coincident(riser.end(), bend.start());
    coincident(bend.end(), topSegment.start());
    vertical(riser);
    tangent(riser, bend);
    tangent(bend, topSegment);
    fix(riser.start(), [0, 0]);
    distance(riser.start(), riser.end(), 1.5);
    radius(bend, 4);
    distance(topSegment.start(), topSegment.end(), 1.5);

    return {
        topSegment
    }
}).reusable();

const profile = sketch("top", () => {
    const innerPipe = circle([0, 0], 1.5);
    const outerPipe = circle([0, 0], 2);
    return {
        innerPipe,
        outerPipe
    }
  });

const pipe = sweep(spine, profile.regions.outerPipe);

sketch("top", () => {
    const bottom = line([-1.75, -1.75], [1.75, -1.75]);
    const right = line([1.75, -1.75], [1.75, 1.75]);
    const top = line([1.75, 1.75], [-1.75, 1.75]);
    const left = line([-1.75, 1.75], [-1.75, -1.75]);
    const bolt = circle([-1.25, -1.25], 0.5);

    coincident(bottom.end(), right.start());
    coincident(right.end(), top.start());
    coincident(top.end(), left.start());
    coincident(left.end(), bottom.start());
    horizontal(bottom);
    vertical(right);
    horizontal(top);
    vertical(left);
    fix(bottom.start(), [-1.75, -1.75]);
    distance(bottom.start(), bottom.end(), 3.5);
    distance(right.start(), right.end(), 3.5);
    fix(bolt.center(), [-1.25, -1.25]);
    diameter(bolt, 0.5);

    fillet(0.5, bottom, right, top, left);
    copy("circular", [0, 0], {
        count: 4,
        angle: 360
    }, bolt);
});

extrude(.375)

sketch(pipe.endFaces(), () => {
    const rim = project(pipe.endFaces()).guide();
    const flange = circle([0, 0], 4);

    concentric(flange, rim);
    diameter(flange, 4);
  });

const upperFlange = extrude(-.625)
