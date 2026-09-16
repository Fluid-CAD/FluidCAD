import {connector, revolve, select, project, arc, xAxis, line, yAxis, breakpoint, repeat, cut, plane, extrude, origin, circle, sketch, part, color } from 'fluidcad/core';
import { horizontal, midpoint, radius, equal, tangent, vertical, distance, diameter, coincident } from 'fluidcad/constraints';
import { edge, face } from 'fluidcad/filters';

export const piston = part('piston', () => {
  sketch('xy', () => {
    const c1 = circle([0, 0], 85);
    coincident(c1.center(), origin());
    diameter(c1, 85);

  });
  const e = extrude(90);
  const p = plane(e.endFaces(), -11.6);
  sketch(p, () => {
    const c2 = circle([0, 0], 79);
    coincident(c2.center(), origin());
    diameter(c2, 79);

  });
  const f = cut(-4.3).thin(5);
  repeat('linear', 'z', { count: 3, offset: -7.3-4.3 }, f);
  sketch(e.startFaces(), () => {
    const c3 = circle([0, 0], 79);
    coincident(c3.center(), origin());
    diameter(c3, 76);

  });

  const c = cut(85);
  sketch('xz', () => {
    const c4 = circle([0, 49.44], 33.8);
    coincident(c4.center(), yAxis());
    diameter(c4, 33.8);
    distance(c4.center(), origin(), 27);

  });
  cut().symmetric();
  sketch('yz', () => {
    const l1 = line([18, 2.36], [18, 0]);
    const l2 = line([18, 0], [-18, 0]);
    const l3 = line([-18, 0], [-18, 2.36]);
    const a1 = arc([-18, 2.36], [-10.67, 12], [-8, 2.36]).cw();
    const a2 = arc([-10.67, 12], [10.67, 12], [0, -26.55]).cw();
    const a3 = arc([10.67, 12], [18, 2.36], [8, 2.36]).cw();
    vertical(l1);
    coincident(l1.end(), xAxis());
    coincident(l2.start(), l1.end());
    coincident(l2.end(), xAxis());
    coincident(l3.start(), l2.end());
    vertical(l3);
    coincident(a1.start(), l3.end());
    tangent(l3, a1);
    coincident(a2.start(), a1.end());
    tangent(a1, a2);
    coincident(a3.start(), a2.end());
    tangent(a2, a3);
    coincident(a3.end(), l1.start());
    tangent(a3, l1);
    equal(l1, l3);
    equal(a1, a3);
    coincident(a2.center(), yAxis());
    distance(a2.end(), l2, 12);
    radius(a2, 40);
    radius(a3, 10);
    midpoint(origin(), l2.start(), l3.start());
    distance(l2.start(), l2.end(), 50);

  });
  cut().symmetric();
  const p2 = plane('xz', 38/2);
  sketch(p2, () => {
    const c5 = circle([0, 26.55], 33.8);
    const c6 = circle([0, 26.55], 45);
    coincident(c5.center(), yAxis());
    diameter(c5, 33.8);
    coincident(c6.center(), c5.center());
    diameter(c6, 45);

  });
  const f2 = extrude(c.internalFaces(face().cylinder()));
  repeat('mirror', 'xz', f2);
  const sel = select(face().cylinder(85).above('xy', 80));
  sketch('xz', () => {
    const prj1 = project(sel).guide();
    const l4 = line([42.5, 100.27], [0, 100.27]);
    const l5 = line([0, 100.27], [0, 105.27]);
    const a4 = arc([0, 105.27], [42.5, 90], [0, 38.49]).cw();
    horizontal(l4);
    coincident(l5.start(), l4.end());
    coincident(l5.end(), yAxis());
    vertical(l5);
    coincident(a4.start(), l5.end());
    coincident(a4.center(), yAxis());
    distance(l5.start(), l5.end(), 5);
    coincident(a4.end(), prj1.ref(1).end());
    coincident(l4.start(), a4.end());

  });

  revolve('z');

  color('#dde1e5');
  connector('c1', select(edge().onPlane('xz', -19).circle(33.8)).center()).offset(0, 0, 19);

  connector('c2', select(edge().onPlane('xz', -19).circle(33.8)).center()).offset(0, 0, 19).rotate('x', 90);

  connector('c3', f.internalFaces(face().cylinder()).center());

  connector('c4', select(face().cylinder(79).above('xy', 60).below('xy', 75)).center());

  connector('c5', select(face().cylinder(79).below('xy', 60)).center());

});
