import { color, connector, breakpoint,fillet, copy,fuse, rotate,select, mirror,plane, circle,project, extrude,yAxis, origin,arc, line,sketch, part } from 'fluidcad/core';
import { diameter,horizontal, angle,distance, radius,tangent, coincident } from 'fluidcad/constraints';
import {face, edge } from 'fluidcad/filters';

export const part1 = part('Part 1', () => {
  sketch('xz', () => {
    const l1 = line([35.51, 23.28], [24.01, -29.23]);
    const a1 = arc([24.01, -29.23], [-20, -30], [1.95, -26.33]).cw();
    const l2 = line([-20, -30], [-29.53, 27]);
    const a2 = arc([-29.53, 27], [35.51, 23.28], [3.05, 26.26]).cw();
    coincident(a1.start(), l1.end());
    coincident(l2.start(), a1.end());
    tangent(a1, l2);
    coincident(a2.start(), l2.end());
    coincident(a2.end(), l1.start());
    radius(a1, 36);
    radius(a2, 80);
    tangent(a1, l1);
    distance(a1.center(), origin(), 44, 'y');
    coincident(a1.center(), yAxis());
    coincident(a2.center(), yAxis());
    angle(l1.start(), l2, 33);
    horizontal(a2.end(), l2.end());
    coincident(a2.center(), origin());

  });
  const e = extrude(15);
  sketch(e.startFaces(), () => {
    const c1 = circle([0, -1], 54);
    coincident(c1.center(), yAxis());
    diameter(c1, 54);
    distance(c1.center(), origin(), 44)
  });

  const e2 = extrude(46);
  sketch(e.endFaces(), () => {
    const c2 = circle([0, 0], 0);
    coincident(c2.center(), origin());
    diameter(c2, 72);
  });

  const f = extrude(38);
  const p = plane(plane(e.startFaces()), plane(e2.endFaces()));
  const f2 = mirror(p, f);
  const p2 = plane(plane(select(face().onPlane('xz', -61))), plane(select(face().onPlane('xz', -99))));
  const f3 = mirror(p2, f2).new();
  const f4 = rotate('y', 180, f3);
  const f5 = fuse(f4, f2);
  const p3 = plane(plane(select(face().onPlane('xz', -175))), plane(select(face().onPlane('xz', -213))));
  mirror(p3, f5);
  sketch(f.endFaces(), () => {
    const c3 = circle([0, 0], 35);
    coincident(c3.center(), origin());
    diameter(c3, 35);

  });
  const e4 = extrude(80);

  sketch(select(face().onPlane('xz', -441)), () => {
    const c4 = circle([0, 0], 110).guide();
    const c5 = circle([0, 0], 144);
    const c6 = circle([0, 58.78], 5);
    coincident(c4.center(), origin());
    diameter(c4, 110);
    coincident(c5.center(), origin());
    diameter(c5, 144);
    coincident(c6.center(), yAxis());
    diameter(c6, 10);
    coincident(c6.center(), c4);
    copy('circular', [0, 0], { count: 8, angle: 360 }, c6);

  });

  const e3 = extrude(15);
  fillet(3, e3.startEdges(7), f.sideEdges(edge().circle()), f.endEdges(), e4.sideEdges(edge().circle()), e4.endEdges(), select(edge().circle().above('xz', -420).below('xz', 10)));
  connector('c1', select(edge().onPlane(e4.endFaces())).center());

  connector('c2', select(face().cylinder(54).above('xz', -44)).center());

  connector('c3', select(face().cylinder(54).above('xy', 15).above('xz', -158)).center())
  connector('c4', select(face().cylinder(54).above('xy', 15).below('xz', -230)).center())
  connector('c5', select(face().cylinder(54).below('xz', -343)).center())

  color('#8d949d');

}).name('Crank Shaft');
