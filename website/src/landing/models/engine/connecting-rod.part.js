import {breakpoint, connector, select, repeat, cut, fillet, project, extrude, yAxis, circle, line, xAxis, origin, arc, sketch, part, color } from 'fluidcad/core';
import { vertical, symmetric, midpoint, equal, tangent, concentric, angle, horizontal, distance, diameter, radius, coincident } from 'fluidcad/constraints';
import { edge, face } from 'fluidcad/filters';

export const connectingRod = part('connecting-rod', () => {
  sketch('xz', () => {
    const a1 = arc([156.36, 0], [-156.36, 0], [0, 0]);
    const a2 = arc([124.37, 0], [-124.37, 0], [0, 0]);
    const l1 = line([-156.36, 0], [-124.37, 0]);
    const l2 = line([124.37, 0], [156.36, 0]);
    const c1 = circle([0, 164.18], 33.8);
    const c2 = circle([0, 164.18], 45);
    coincident(a1.center(), origin());
    coincident(a1.start(), xAxis());
    coincident(a1.end(), xAxis());
    coincident(a2.center(), origin());
    coincident(a2.start(), xAxis());
    coincident(a2.end(), xAxis());
    coincident(l1.start(), a1.end());
    coincident(l1.end(), a2.end());
    coincident(l2.start(), a2.start());
    coincident(l2.end(), a1.start());
    radius(a2, 27);
    radius(a1, 36);
    coincident(c1.center(), yAxis());
    diameter(c1, 33.8);
    coincident(c2.center(), c1.center());
    diameter(c2, 45);
    distance(c1.center(), a1.center(), 201.2);

  });
  const e = extrude(38).symmetric();
  sketch('xz', () => {
    const prj1 = project(e.startEdges(3, 4)).guide();
    const l4 = line([-10, 181.04], [-18.04, 31.15]);
    const l3 = line([10, 181.04], [17.66, 31.37]);
    const a3 = arc([-10, 181.04], [10, 181.04], [0, 185.83]);
    const a4 = arc([-17.85, 31.26], [17.85, 31.26], [0, 19.79]).cw();
    horizontal(l3.start(), l4.start());
    coincident(l4.start(), prj1.ref(1));
    distance(l4.start(), l3.start(), 20);
    coincident(l3.start(), prj1.ref(1));
    coincident(l3.end(), prj1.ref(0));
    coincident(l4.end(), prj1.ref(0));
    angle(l4, l3, 6);
    horizontal(l3.end(), l4.end());
    coincident(a3.start(), l4.start());
    coincident(a3.end(), l3.start());
    coincident(a4.start(), l4.end());
    coincident(a4.end(), l3.end());
    concentric(a4, prj1.ref(0));
    concentric(a3, prj1.ref(1));

  });
  const e2 = extrude(18).symmetric();
  fillet(40, e2.sideEdges(9, 10));
  fillet(22.5, e2.sideEdges(8, 11));
  sketch('xy', () => {
    const l5 = line([-38, -9], [38, -9]);
    const a5 = arc([38, -9], [38, 9], [38, 0]);
    const l6 = line([38, 9], [-38, 9]);
    const a6 = arc([-38, 9], [-38, -9], [-38, 0]);
    coincident(l5.end(), a5.start());
    coincident(a5.end(), l6.start());
    coincident(l6.end(), a6.start());
    coincident(a6.end(), l5.start());
    tangent(l5, a5);
    tangent(a5, l6);
    tangent(l6, a6);
    tangent(a6, l5);
    equal(a5, a6);
    distance(a6.center(), a5.center(), 76);
    radius(a5, 9);
    coincident(a5.center(), xAxis());
    midpoint(origin(), a6.center(), a5.center());

  });
  const e3 = extrude(30);
  sketch(e3.sideFaces(4), () => {
    project(e3.sideFaces(face().above('xz').edgeCount(2)));

  });
  cut();
  sketch(e3.endFaces(1), () => {
    const c3 = circle([38, 2.98], 9);
    const c4 = circle([-38, 2.98], 9);
    equal(c3, c4);
    diameter(c3, 9);
    distance(c3.center(), c4.center(), 76);
    symmetric(c3.center(), c4.center(), yAxis());
    coincident(c3.center(), xAxis());

  });
  const c7 = cut();
  sketch(e3.sideFaces(5), () => {
    const l7 = line([0, 0], [0, 100.6]).guide();
    const l8 = line([36.61, 167.14], [-7, 88.41]);
    const a7 = arc([-7, 88.41], [7, 80.66], [0, 84.54]);
    const l9 = line([7, 80.66], [50.61, 159.39]);
    const a8 = arc([50.61, 159.39], [36.61, 167.14], [43.61, 163.26]);
    coincident(l7.start(), origin());
    vertical(l7);
    distance(l7.start(), l7.end(), 201.2/2);
    coincident(l8.end(), a7.start());
    coincident(a7.end(), l9.start());
    coincident(l9.end(), a8.start());
    coincident(a8.end(), l8.start());
    tangent(l8, a7);
    tangent(a7, l9);
    tangent(l9, a8);
    tangent(a8, l8);
    equal(a7, a8);
    distance(a8.center(), a7.center(), 90);
    radius(a7, 8);
    coincident(a7.center(), l7);
    vertical(a7.center(), a8.center());
    midpoint(l7.end(), a7.center(), a8.center());

  });
  const c = cut(4);
  const f = fillet(1, c.endEdges());
  repeat('mirror', 'xz', c, f);
  fillet(1.4, e3.sideEdges(12, 15));

  color('#a4aab2');
  connector('c1', e.internalFaces().center());

  connector('c2', select(edge().arc(27).onPlane(e.startFaces())).center()).offset(0, 0, -19);
  connector('c3', c7.endEdges(edge().below('yz')).center());
});
export const part1 = part('Part 1', () => {
  sketch('xy', () => {
    const l10 = line([-38, -9], [38, -9]);
    const a9 = arc([38, -9], [38, 9], [38, 0]);
    const l11 = line([38, 9], [-38, 9]);
    const a10 = arc([-38, 9], [-38, -9], [-38, 0]);
    coincident(l10.end(), a9.start());
    coincident(a9.end(), l11.start());
    coincident(l11.end(), a10.start());
    coincident(a10.end(), l10.start());
    tangent(l10, a9);
    tangent(a9, l11);
    tangent(l11, a10);
    tangent(a10, l10);
    equal(a9, a10);
    distance(a10.center(), a9.center(), 76);
    radius(a9, 9);
    coincident(a9.center(), xAxis());
    midpoint(origin(), a10.center(), a9.center());

  });
  const e4 = extrude(-60);
  sketch('xz', () => {
    const a11 = arc([27, 0], [-25.84, 7.84], [0, 0]).cw();
    const a12 = arc([36, 0], [-35.14, 7.84], [0, 0]).cw();
    const l12 = line([27, 0], [36, 0]);
    const l13 = line([-35.14, 7.84], [-25.84, 7.84]);
    coincident(a11.center(), origin());
    coincident(a12.center(), origin());
    radius(a11, 27);
    radius(a12, 36);
    coincident(l12.start(), a11.start());
    coincident(l12.end(), a12.start());
    horizontal(l12);
    coincident(l13.start(), a12.end());
    coincident(l13.end(), a11.end());
    horizontal(l13);
    coincident(a12.start(), xAxis());
    coincident(a12.end(), xAxis());

  });
  const e5 = extrude(38).symmetric();
  const sel = select(face().onPlane('xz', 9).edgeCount(2));
  sketch(e4.sideFaces(3), () => {
    project(sel);

  });
  cut();
  sketch(e4.endFaces(), () => {
    const c6 = circle([33.5, 0], 10.62);
    const c5 = circle([-31.18, 0], 9.85);
    coincident(c5.center(), xAxis());
    equal(c6, c5);
    diameter(c6, 9);
    distance(c6.center(), c5.center(), 76);
    symmetric(c6.center(), c5.center(), yAxis());

  });
  const c8 = cut();
  sketch('xz', () => {
    const l14 = line([93.61, -18.25], [93.61, -54.98]);
    const l15 = line([93.61, -54.98], [65.34, -54.98]);
    const l16 = line([65.34, -54.98], [93.61, -18.25]);
    vertical(l14);
    coincident(l15.start(), l14.end());
    horizontal(l15);
    coincident(l16.start(), l15.end());
    coincident(l16.end(), l14.start());
    distance(l14.start(), l14.end(), 22);
    distance(l15.start(), l15.end(), 27);
    distance(l15.start(), xAxis(), 60);
    distance(l15.start(), yAxis(), (76+18) / 2);

  });
  const f2 = cut().symmetric();
  repeat('mirror', 'yz', f2);
  fillet(1.4, select(edge().concave()));

  fillet(10, f2.internalEdges(edge().line()), select(edge().onPlane(e4.endFaces()).below('yz')));
color('#a4aab2');
connector('c1', c8.endEdges(edge().below('yz')).center());
}).name('connecting-rod-cap');
