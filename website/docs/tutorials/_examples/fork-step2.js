// @screenshot waitForInput hideGrid
import { arc, circle, cut, extrude, line, local, mirror, plane, sketch } from "fluidcad/core";
import { coincident, concentric, distance, fix, horizontal, radius, vertical } from "fluidcad/constraints";

sketch("front", () => {
    // Arch: two concentric semicircles closed at both ends (wall thickness 18)
    const inner = arc([18, 0], [-18, 0], [0, 0]);
    const outer = arc([36, 0], [-36, 0], [0, 0]);
    const capR = line([18, 0], [36, 0]);
    const capL = line([-36, 0], [-18, 0]);

    // Right leg, 18 x 40, hanging below the arch's right end
    const legB = line([18, -40], [36, -40]);
    const legR = line([36, -40], [36, 0]);
    const legT = line([36, 0], [18, 0]);
    const legL = line([18, 0], [18, -40]);

    // Column, 36 wide, from y = 18 up to the 129 overall height
    const colB = line([-18, 18], [18, 18]);
    const colR = line([18, 18], [18, 129]);
    const colT = line([18, 129], [-18, 129]);
    const colL = line([-18, 129], [-18, 18]);

    coincident(inner.start(), capR.start());
    coincident(capR.end(), outer.start());
    coincident(outer.end(), capL.start());
    coincident(capL.end(), inner.end());
    concentric(inner, outer);
    horizontal(capR);
    horizontal(capL);
    fix(inner.center(), [0, 0]);
    radius(inner, 18);
    radius(outer, 36);

    coincident(legB.end(), legR.start());
    coincident(legR.end(), legT.start());
    coincident(legT.end(), legL.start());
    coincident(legL.end(), legB.start());
    horizontal(legB);
    vertical(legR);
    horizontal(legT);
    vertical(legL);
    fix(legT.end(), [18, 0]);
    distance(legB.start(), legB.end(), 18);
    distance(legR.start(), legR.end(), 40);

    coincident(colB.end(), colR.start());
    coincident(colR.end(), colT.start());
    coincident(colT.end(), colL.start());
    coincident(colL.end(), colB.start());
    horizontal(colB);
    vertical(colR);
    horizontal(colT);
    vertical(colL);
    fix(colB.start(), [-18, 18]);
    distance(colB.start(), colB.end(), 36);
    distance(colR.start(), colR.end(), 129 - 18);

    mirror(local("y"), legB, legR, legT, legL);
});

extrude(36).symmetric();

sketch(plane("right", 18), () => {
    circle([0, -38], 60);
});

const bossDepth = (80 - 36) / 2
const e = extrude(bossDepth);

mirror("right")
