// @screenshot waitForInput
import { arc, circle, cut, extrude, line, mirror, origin, plane, project, repeat,
    sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, concentric, diameter, distance, equal, horizontal, midpoint,
    radius, tangent, vertical } from "fluidcad/constraints";
import { edge } from "fluidcad/filters";

sketch('xy', () => {
  const bottom = line([-47, -33], [47, -33]);
  const br = arc([47, -33], [60, -20], [47, -20]);
  const right = line([60, -20], [60, 20]);
  const tr = arc([60, 20], [47, 33], [47, 20]);
  const top = line([47, 33], [-47, 33]);
  const tl = arc([-47, 33], [-60, 20], [-47, 20]);
  const left = line([-60, 20], [-60, -20]);
  const bl = arc([-60, -20], [-47, -33], [-47, -20]);
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
  equal(br, tr);
  equal(br, tl);
  equal(br, bl);
  distance(left, right, 120);
  distance(bottom, top, 66);
  radius(br, 13);
  midpoint(origin(), bl.center(), tr.center());
});

const plate = extrude(13);

sketch(plate.endFaces(), () => {
  const lower = line([50, -7], [70, -7]);
  const outer = arc([70, -7], [70, 7], [70, 0]);
  const upper = line([70, 7], [50, 7]);
  const cap = arc([50, 7], [50, -7], [50, 0]);
  coincident(lower.end(), outer.start());
  coincident(outer.end(), upper.start());
  coincident(upper.end(), cap.start());
  coincident(cap.end(), lower.start());
  tangent(lower, outer);
  tangent(outer, upper);
  tangent(upper, cap);
  tangent(cap, lower);
  equal(outer, cap);
  distance(cap.center(), outer.center(), 20);
  radius(outer, 7);
  coincident(cap.center(), xAxis());
  coincident(outer.center(), xAxis());
  distance(cap.center(), yAxis(), 50);
});

const notch = cut();

repeat('mirror', 'yz', notch);

sketch('xz', () => {
  const dome = arc([31, 0], [-31, 0], [0, 0]);
  const flat = line([-31, 0], [31, 0]);
  coincident(dome.center(), origin());
  coincident(dome.start(), xAxis());
  radius(dome, 31);
  coincident(flat.start(), dome.end());
  coincident(flat.end(), dome.start());
  horizontal(flat);
});

const barrel = extrude(66).symmetric();

sketch('xz', () => {
  const bore = circle([0, 0], 36);
  coincident(bore.center(), origin());
  diameter(bore, 36);
});

cut(66).symmetric();

const webPlane = plane('xz', 20);

sketch(webPlane, () => {
  const domeArc = project(barrel.startEdges(edge().arc())).guide();
  const pipe = circle([0, 45], 16).guide();
  const right = line([32.57, 20.95], [6.88, 50.69]);
  const cap = arc([6.88, 50.69], [-7.28, 50.69], [-0.2, 45.13]);
  const left = line([-7.28, 50.69], [-32.98, 20.95]);
  const bridge = arc([-32.98, 20.95], [32.57, 20.95], [-0.2, -16.38]).cw();
  coincident(pipe.center(), yAxis());
  diameter(pipe, 16);
  distance(pipe.center(), xAxis(), 45);
  coincident(cap.start(), right.end());
  coincident(left.start(), cap.end());
  coincident(bridge.start(), left.end());
  coincident(bridge.end(), right.start());
  tangent(right, cap);
  tangent(cap, left);
  tangent(left, bridge);
  tangent(right, bridge);
  concentric(cap, pipe);
  equal(cap, pipe);
  concentric(bridge, domeArc);
  equal(bridge, domeArc);
});

extrude(11);

const pipePlane = plane('xz', 35);

sketch(pipePlane, () => {
  const wall = circle([0, 45], 16);
  const bore = circle([0, 45], 10);
  diameter(wall, 16);
  coincident(wall.center(), yAxis());
  distance(wall.center(), xAxis(), 45);
  coincident(bore.center(), wall.center());
  diameter(bore, 10);
});
