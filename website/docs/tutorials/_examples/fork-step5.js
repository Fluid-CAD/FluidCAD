// @screenshot waitForInput
import { arc, circle, cut, extrude, line, mirror, origin, plane, project, repeat,
    sketch, xAxis, yAxis } from "fluidcad/core";
import { angle, coincident, concentric, diameter, distance, equal, horizontal,
    radius, tangent, vertical } from "fluidcad/constraints";
import { edge } from "fluidcad/filters";

sketch("xz", () => {
    // Arch wall: two semicircles centred on the origin, R18 inside, R36 outside
    const inner = arc([18, 0], [-18, 0], [0, 0]);
    const outer = arc([36, 0], [-36, 0], [0, 0]);
    coincident(inner.center(), origin());
    coincident(inner.start(), xAxis());
    coincident(inner.end(), xAxis());
    radius(inner, 18);
    coincident(outer.center(), origin());
    coincident(outer.start(), xAxis());
    coincident(outer.end(), xAxis());
    radius(outer, 36);

    // Right leg: three lines hanging from the two ends of the arch wall
    const legInner = line([18, 0], [18, -40]);
    const legOuter = line([36, 0], [36, -40]);
    const legBottom = line([18, -40], [36, -40]);
    coincident(legInner.start(), inner.start());
    vertical(legInner);
    coincident(legOuter.start(), outer.start());
    vertical(legOuter);
    coincident(legBottom.start(), legInner.end());
    coincident(legBottom.end(), legOuter.end());
    horizontal(legBottom);
    distance(legInner.end(), xAxis(), 40);

    // Column: 36 wide, its top face 129 above the arch centreline
    const colBottom = line([-18, 18], [18, 18]);
    const colRight = line([18, 18], [18, 129]);
    const colTop = line([18, 129], [-18, 129]);
    const colLeft = line([-18, 129], [-18, 18]);
    coincident(colBottom.end(), colRight.start());
    coincident(colRight.end(), colTop.start());
    coincident(colTop.end(), colLeft.start());
    coincident(colLeft.end(), colBottom.start());
    horizontal(colBottom);
    horizontal(colTop);
    vertical(colRight);
    vertical(colLeft);
    distance(colBottom.start(), colBottom.end(), 36);
    distance(colRight.start(), colRight.end(), 111);
    distance(colBottom.start(), yAxis(), 18);
    distance(colTop.start(), xAxis(), 129);

    mirror(yAxis(), legInner, legOuter, legBottom);
});

const body = extrude(36).symmetric();

const bossPlane = plane("yz", 18);

sketch(bossPlane, () => {
    const disc = circle([0, -38], 60);
    coincident(disc.center(), yAxis());
    diameter(disc, 60);
    distance(disc.center(), xAxis(), 38);
});

const boss = extrude(22);

repeat("mirror", "yz", boss);

sketch(boss.endFaces(), () => {
    const rim = project(boss.startEdges(edge().arc()));
    const bore = circle([0, -38], 30);
    diameter(bore, 30);
    concentric(bore, rim);
});

cut();

sketch(body.sideFaces(6), () => {
    const post = circle([0, 0], 30);
    coincident(post.center(), origin());
    diameter(post, 30);
});

const postStep = cut(20).thin(20);

sketch(postStep.internalFaces(0), () => {
    // What the Polygon tool wrote: four equal sides tangent to a 36 guide circle
    const s1 = line([25.46, 0], [0, 25.46]);
    const s2 = line([0, 25.46], [-25.46, 0]);
    const s3 = line([-25.46, 0], [0, -25.46]);
    const s4 = line([0, -25.46], [25.46, 0]);
    const guide = circle([0, 0], 36).guide();
    coincident(s1.end(), s2.start());
    coincident(s2.end(), s3.start());
    coincident(s3.end(), s4.start());
    coincident(s4.end(), s1.start());
    equal(s1, s2, s3);
    tangent(s1, guide);
    tangent(s2, guide);
    tangent(s3, guide);
    tangent(s4, guide);
    angle(s1, s2, 90);
    diameter(guide, 36);
    coincident(guide.center(), origin());
    coincident(s1.start(), xAxis());
});

cut(45).thin(20);
