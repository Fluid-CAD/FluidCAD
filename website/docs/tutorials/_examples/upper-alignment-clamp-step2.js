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
