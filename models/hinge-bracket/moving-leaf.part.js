import { part, sketch, line, circle, plane, extrude, cut, connector, color, origin } from "fluidcad/core";
import { coincident, horizontal, vertical, fix, distance, diameter } from "fluidcad/constraints";

// ASSUMPTION: leaf pivot at origin along Z; arm extends +X.
// ASSUMPTION: 15 mm leaf fits the 16 mm gap with 0.5 mm clearance per side.
const thickness = 15;
const armLength = 45;
const armWidth = 18;
const boreDiameter = 8;
export const leaf = part("Moving leaf", () => {
  sketch(plane("xy", -thickness/2), () => {
    const b = line([0,-armWidth/2],[armLength,-armWidth/2]);
    const r = line([armLength,-armWidth/2],[armLength,armWidth/2]);
    const t = line([armLength,armWidth/2],[0,armWidth/2]);
    const l = line([0,armWidth/2],[0,-armWidth/2]);
    coincident(b.end(),r.start()); coincident(r.end(),t.start());
    coincident(t.end(),l.start()); coincident(l.end(),b.start());
    horizontal(b); vertical(r); horizontal(t); vertical(l);
    fix(b.start(),[0,-armWidth/2]);
    distance(b.start(),b.end(),armLength); distance(r.start(),r.end(),armWidth);
  });
  extrude(thickness);

  sketch(plane("xy", -thickness/2), () => {
    const hub = circle([0,0],armWidth);
    coincident(hub.center(),origin()); diameter(hub,armWidth);
  });
  extrude(thickness);

  sketch(plane("xy", thickness/2), () => {
    const bore = circle([0,0],boreDiameter);
    coincident(bore.center(),origin()); diameter(bore,boreDiameter);
  });
  cut(thickness);
  connector("pivot", plane("xy"));
  color("tomato");
});
