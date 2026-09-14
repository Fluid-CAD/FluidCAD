import { color, connector,select, repeat,cut, plane,breakpoint, revolve,project, yAxis,xAxis, arc,origin, line,extrude, circle,sketch, part } from 'fluidcad/core';
import {midpoint, radius,symmetric, diameter,equal, distance,tangent, horizontal,vertical, coincident } from 'fluidcad/constraints';
import {edge, face } from 'fluidcad/filters';
export const piston = part('Piston', () => {
  sketch('xy', () => {
    const c1 = circle([0, 0], 85);
    coincident(c1.center(), origin());
    diameter(c1, 85);

  });
  const e = extrude(90);
  const p = plane(e.endFaces(), -11.6);

  sketch('xz', () => {
    const prj1 = project(e.sideFaces());
    const a1 = arc([0, 103.66], [42.5, 90], [-35.46, -79.58]).cw();
    const l1 = line([-45.7, 107.56], [53.57, 99.09]).guide();
    const l2 = line([42.5, 90], [0, 90]);
    const l3 = line([0, 90], [0, 103.66]);
    coincident(a1.end(), prj1.end());
    coincident(a1.start(), yAxis());
    distance(l1, prj1.end(), 5);
    coincident(a1.start(), l1);
    horizontal(l2);
    coincident(l2.start(), a1.end());
    coincident(l2.end(), yAxis());
    coincident(l3.start(), l2.end());
    vertical(l3);
    coincident(l3.end(), a1.start());
    horizontal(l1);
    tangent(a1, l1);

  });
  revolve('z');
  sketch(p, () => {
    const c2 = circle([0.02, 0], 79);
    diameter(c2, 79);

  });
  const f = cut(-4.3).thin(5);

  repeat('linear', 'z', { count: 3, offset: -7.3-4.3 }, f);

  sketch(e.startFaces(), () => {
    const c3 = circle([0.02, 0], 76);
    diameter(c3, 76);

  });
  const c = cut(85);
  sketch('xz', () => {
    const c4 = circle([0, 43.17], 34.92);
    coincident(c4.center(), yAxis());
    distance(c4.center(), xAxis(), 27);
    diameter(c4, 33.8);

  });
  cut().symmetric();
  sketch('yz', () => {
    const l4 = line([-25, 0], [25, 0]);
    const l5 = line([25, 0], [25, 11.05]);
    const a2 = arc([18.21, 20.52], [-21.79, 12], [5.37, -17.36]);
    const l6 = line([-25, 4.66], [-25, 0]);
    const a3 = arc([25, 11.05], [18.21, 20.52], [15, 11.05]);
    const a4 = arc([-25, 4.66], [-21.79, 12], [-15, 4.66]).cw();
    coincident(l4.start(), xAxis());
    coincident(l5.start(), l4.end());
    vertical(l5);
    vertical(l6);
    coincident(l6.end(), l4.start());
    distance(l4.start(), l4.end(), 50);
    radius(a2, 40);
    symmetric(l4.end(), l6.end(), yAxis());
    coincident(a3.start(), l5.end());
    coincident(a3.end(), a2.start());
    tangent(l5, a3);
    tangent(a3, a2);
    radius(a3, 10);
    coincident(a4.start(), l6.start());
    coincident(a4.end(), a2.end());
    tangent(l6, a4);
    tangent(a4, a2);
    equal(a4, a3);
    distance(a4.end(), l4, 12);
    equal(l5, l6);

  });

  cut().symmetric();

  const p2 = plane('xz', 19);
  sketch(p2, () => {
    const c5 = circle([0, 25.96], 27);
    const c6 = circle([0, 27], 45);
    coincident(c5.center(), yAxis());
    diameter(c5, 33.8);
    distance(c5.center(), xAxis(), 27);
    coincident(c6.center(), c5.center());
    diameter(c6, 45);

  });
  const f2 = extrude(c.internalFaces(0));
  repeat('mirror', 'xz', f2);
  connector('c1', select(edge().onPlane('xz', 19).circle(33.8)).center()).offset(0, 0, -19);
  connector('c2', select(edge().onPlane('xz', -19).circle(33.8)).center()).offset(0, 0, 19).rotate('x', 90);

  // Ring seats: the floor of each groove (the grooves cut upward from their sketch plane), top groove first, 11.6 pitch.

  connector('c3', f.internalFaces(face().cylinder()).center())

  connector('c4', select(face().cylinder(79).above('xy', 60).below('xy', 75)).center());
  connector('c5', select(face().cylinder(79).below('xy', 60)).center());

  color('#dde1e5');
});
