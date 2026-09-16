import {breakpoint, connector, fillet, chamfer, copy, fuse, rotate, select, mirror, plane, circle, extrude, origin, line, yAxis, arc, sketch, part, color } from 'fluidcad/core';
import { diameter, angle, horizontal, distance, radius, tangent, coincident } from 'fluidcad/constraints';
import { edge, face } from 'fluidcad/filters';

export const part1 = part('crank-shaft', () => {
  sketch('xz', () => {
    const a1 = arc([-35.58, -49.46], [35.94, -46.16], [0, -44]);
    const a2 = arc([-52.45, 60.41], [42.78, 67.6], [0, 0]).cw();
    const l1 = line([42.78, 67.6], [35.94, -46.16]);
    const l2 = line([-52.45, 60.41], [-35.58, -49.46]);
    coincident(a1.center(), yAxis());
    coincident(a2.center(), yAxis());
    coincident(l1.start(), a2.end());
    coincident(l1.end(), a1.end());
    coincident(l2.start(), a2.start());
    coincident(l2.end(), a1.start());
    tangent(a1, l1);
    tangent(a1, l2);
    radius(a1, 36);
    radius(a2, 80);
    coincident(a2.center(), origin());
    distance(a1.center(), a2.center(), 44);
    horizontal(a2.end(), a2.start());
    angle(l1.start(), l2.start(), 33);

  });
  const e = extrude(15);
  sketch(e.startFaces(), () => {
    const c1 = circle([0, -35.94], 54);
    coincident(c1.center(), yAxis());
    diameter(c1, 54);
    distance(origin(), c1.center(), 44);

  });
  const e2 = extrude(46);
  sketch(e.endFaces(), () => {
    const c2 = circle([0, 0], 72);
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
  sketch(select(face().onPlane('xz', -441)), () => {
    const c3 = circle([0, 0], 144);
    const c4 = circle([0, 54.03], 10);
    coincident(c3.center(), origin());
    diameter(c3, 144);
    coincident(c4.center(), yAxis());
    diameter(c4, 10);
    distance(c4.center(), c3.center(), 110/2);
    copy('circular', [0, 0], { count: 8, angle: 360 }, c4);

  });
  const e4 = extrude(15);
  sketch(f.endFaces(), () => {
    const c5 = circle([1.92, 4.22], 32);
    diameter(c5, 32);
    coincident(c5.center(), origin());

  });
  const e3 = extrude(80);
  chamfer(2, e3.endFaces());
  fillet(3, f.endEdges(), select(edge().concave().below(e3.startFaces())));

  color('#8d949d');
  connector('c1', select(face().onPlane(e3.endFaces())).center());
  connector('c2', select(face().cylinder(54).above('xz', -44)).center());

  connector('c3', select(face().cylinder(54).above('xy', 15).above('xz', -158)).center());

  connector('c4', select(face().cylinder(54).above('xy', 15).below('xz', -230)).center());

  connector('c5', select(face().cylinder(54).below('xz', -343)).center());

});
