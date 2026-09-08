import { sketch, line, arc, origin } from 'fluidcad/core';
import { coincident, tangent, horizontal, vertical, equal, distance, radius, midpoint } from 'fluidcad/constraints';

sketch("xy", () => {
    // Rounded + Centered: the centre clicked on the origin, then 120 (W),
    // 66 (H) and 13 (R) typed. The loop runs counter-clockwise from the
    // bottom side: line, corner arc, line, corner arc, ...
    const bottom = line([-47, -33], [47, -33]);
    const br = arc([47, -33], [60, -20], [47, -20]);
    const right = line([60, -20], [60, 20]);
    const tr = arc([60, 20], [47, 33], [47, 20]);
    const top = line([47, 33], [-47, 33]);
    const tl = arc([-47, 33], [-60, 20], [-47, 20]);
    const left = line([-60, 20], [-60, -20]);
    const bl = arc([-60, -20], [-47, -33], [-47, -20]);
    // Eight junctions, each closed and made smooth.
    coincident(bottom.end(), br.start());
    coincident(br.end(), right.start());
    coincident(right.end(), tr.start());
    coincident(tr.end(), top.start());
    coincident(top.end(), tl.start());
    coincident(tl.end(), left.start());
    coincident(left.end(), bl.start());
    coincident(bl.end(), bottom.start());
    tangent(bottom, br);
    tangent(br, right);
    tangent(right, tr);
    tangent(tr, top);
    tangent(top, tl);
    tangent(tl, left);
    tangent(left, bl);
    tangent(bl, bottom);
    horizontal(bottom);
    horizontal(top);
    vertical(right);
    vertical(left);
    // One radius for all four corners: the first arc carries the
    // dimension, the other three are equal to it.
    equal(br, tr);
    equal(br, tl);
    equal(br, bl);
    // Overall width and height are side-to-side distances, because the
    // sharp corners no longer exist.
    distance(left, right, 120);
    distance(bottom, top, 66);
    radius(br, 13);
    // The centre has no vertex on it either, so the snapped origin becomes
    // the midpoint between two diagonal corner-arc centres.
    midpoint(origin(), bl.center(), tr.center());
})
