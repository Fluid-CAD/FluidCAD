import { color, sweep, connector,repeat, select,expose, cut,breakpoint, fillet,project, extrude,yAxis, circle,line, xAxis,origin, arc,sketch, part } from 'fluidcad/core';
import { midpoint, symmetric,equal, tangent,vertical, fix,angle, distance,diameter, horizontal,radius, coincident } from 'fluidcad/constraints';
import {edge, face } from 'fluidcad/filters';
export const connectingRod = part('Connecting Rod', () => {
  sketch('xz', () => {
    const a1 = arc([100.86, 0], [-100.17, 11.75], [0, 0]);
    const a2 = arc([74.97, 0], [-74.26, 10.27], [0, 0]);
    const l1 = line([25.5, -7.81], [34.53, -7.81]);
    const l2 = line([-36.92, -6.75], [-28.51, -6.75]);
    const c1 = circle([0, 201.86], 45);
    const c2 = circle([0, 201.86], 33.8);
    coincident(a1.center(), origin());
    coincident(a1.start(), xAxis());
    coincident(xAxis(), a1.end());
    coincident(a2.center(), origin());
    coincident(a2.start(), xAxis());
    coincident(xAxis(), a2.end());
    radius(a1, 36);
    radius(a2, 27);
    horizontal(l1);
    horizontal(l2);
    coincident(l2.end(), a2.end());
    coincident(l2.start(), a1.end());
    coincident(l1.start(), a2.start());
    coincident(a1.start(), l1.end());
    coincident(c1.center(), yAxis());
    diameter(c1, 45);
    coincident(c2.center(), c1.center());
    diameter(c2, 33.8);
    distance(c1.center(), a1.center(), 201.2);

  });
  const e = extrude(38).symmetric();
  sketch('xz', () => {
    const prj1 = project(e.startEdges(3, 4)).guide();
    const l4 = line([-20, 170], [-53.86, 60.15]);
    const l3 = line([14.69, 159.89], [56.61, 49.09]);
    const a3 = arc([-17.85, 31.26], [17.85, 31.26], [0, 0]).cw();
    const a4 = arc([-10, 181.04], [10, 181.04], [0, 174.57]);
    horizontal(l3.start(), l4.start());
    distance(l3.start(), l4.start(), 20);
    coincident(l4.start(), prj1.ref(1));
    coincident(l3.start(), prj1.ref(1));
    coincident(l4.end(), prj1.ref(0));
    coincident(l3.end(), prj1.ref(0));
    angle(l4, l3, 6);
    horizontal(l3.end(), l4.end());
    coincident(a3.start(), l4.end());
    coincident(a3.end(), l3.end());
    fix(a3.center());
    coincident(a4.start(), l4.start());
    coincident(a4.end(), l3.start());
    coincident(prj1.ref(1).center(), a4.center());

  });

  const e2 = extrude(18).symmetric();

  fillet(40, e2.sideEdges(9, 10));
  fillet(22.5, e2.sideEdges(8, 11));

  sketch(e.sideFaces(0), () => {
    const l5 = line([-57.56, -9], [18.44, -9]);
    const a5 = arc([18.44, -9], [18.44, 9], [18.44, 0]);
    const l6 = line([18.44, 9], [-57.56, 9]);
    const a6 = arc([-57.56, 9], [-57.56, -9], [-57.56, 0]);
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
    symmetric(a5.center(), a6.center(), yAxis());

  });

  const e3 = extrude(-30);
  fillet(1.4, e3.sideEdges(12, 15));

  sketch(e3.sideFaces(4), () => {
    project(e3.sideFaces(face().above('xz').edgeCount(2)));

  });
  cut();
  sketch(e3.endFaces(1), () => {
    const c3 = circle([-64.87, 0], 22.25);
    const c4 = circle([82.38, 0], 25.14);
    coincident(c3.center(), xAxis());
    equal(c4, c3);
    diameter(c4, 9);
    distance(c4.center(), c3.center(), 76);
    symmetric(c4.center(), c3.center(), yAxis());

  });
  const c7 = cut();


  expose('g1', select(face().onPlane('xy').above('yz', 25)));
  connector('c1', c7.endEdges(edge().below('yz')).center());
  connector('c2', e.internalFaces().center());

  expose('g2', select(face().onPlane(e2.startFaces())));
  sketch(e3.sideFaces(5), () => {
    const prj2 = project(e.startEdges(5)).guide();
    const l14 = line([0, 0], [0, 100.6]).guide();
    const l15 = line([-21.45, 135.59], [-21.45, 65.61]);
    const a11 = arc([-21.45, 65.61], [21.45, 65.61], [0, 65.61]);
    const l16 = line([21.45, 65.61], [21.45, 135.59]);
    const a12 = arc([21.45, 135.59], [-21.45, 135.59], [0, 135.59]);
    const l17 = line([0, 0], [0, 201.2]);
    coincident(l14.start(), origin());
    vertical(l14);
    distance(l14.start(), l14.end(), 201.2/2);
    coincident(l15.end(), a11.start());
    coincident(a11.end(), l16.start());
    coincident(l16.end(), a12.start());
    coincident(a12.end(), l15.start());
    tangent(l15, a11);
    tangent(a11, l16);
    tangent(l16, a12);
    tangent(a12, l15);
    equal(a11, a12);
    midpoint(l14.end(), a12.center(), a11.center());
    vertical(a12.center(), l14.end());
    coincident(l17.start(), origin());
    coincident(l17.end(), prj2.center());
    radius(a12, 8);
    distance(a11.center(), a12.center(), 90);
    
  });
  const c8 = cut(4);
  const f2 = fillet(1, c8.endEdges());
  repeat('mirror', 'xz', c8, f2);

  color('#a4aab2');

}).name('Connecting Rod');

export const connectingRodCap = part('Connecting Rod Cap', () => {
  sketch(connectingRod.features.g1, () => {
    const l7 = line([53.51, 27.41], [129.47, 25.08]);
    const a7 = arc([129.47, 25.08], [130.02, 43.07], [129.75, 34.07]);
    const l8 = line([130.02, 43.07], [54.06, 45.4]);
    const a8 = arc([54.06, 45.4], [53.51, 27.41], [53.78, 36.4]);
    coincident(l7.end(), a7.start());
    coincident(a7.end(), l8.start());
    coincident(l8.end(), a8.start());
    coincident(a8.end(), l7.start());
    tangent(l7, a7);
    tangent(a7, l8);
    tangent(l8, a8);
    tangent(a8, l7);
    equal(a7, a8);
    radius(a7, 9);
    distance(a8.center(), a7.center(), 76);
    horizontal(a8.center(), a7.center());
    coincident(a7.center(), xAxis());
    symmetric(a7.center(), a8.center(), yAxis());

  });
  const e4 = extrude(60);
  sketch('xz', () => {
    const a9 = arc([27, 0], [-27, 0], [0, 0]).cw();
    const a10 = arc([38.58, 0], [-38.03, 6.49], [0, 0]).cw();
    const l9 = line([10, 40], [40, 40]);
    const l10 = line([-54.51, 0], [-27, 0]);
    coincident(a9.center(), origin());
    symmetric(a9.start(), a9.end(), yAxis());
    radius(a9, 27);
    coincident(a9.start(), xAxis());
    coincident(a10.center(), origin());
    horizontal(l9);
    horizontal(l10);
    coincident(l10.end(), a9.end());
    horizontal(a10.end(), a10.start());
    coincident(a10.end(), xAxis());
    coincident(l10.start(), a10.end());
    coincident(l9.end(), a10.start());
    coincident(l9.start(), a9.start());
    radius(a10, 36);

  });
  const e5 = extrude(38).symmetric();
  const sel = select(face().onPlane('xz', 9).edgeCount(2));
  sketch(e4.sideFaces(3), () => {
    project(sel);

  });
  cut();
  sketch(e4.startFaces(), () => {
    const c6 = circle([-16.18, 0], 19.07);
    const c5 = circle([59.82, 0], 19.07);
    equal(c5, c6);
    distance(c6.center(), c5.center(), 76);
    coincident(c6.center(), xAxis());
    symmetric(c5.center(), c6.center(), yAxis());
    diameter(c5, 9);

  });
  const c = cut();
  fillet(1.4, e5.sideEdges(16, 17));

  sketch('xz', () => {
    const l11 = line([17.71, -61.1], [17.71, -39.1]);
    const l12 = line([17.71, -39.1], [-9.29, -61.1]);
    const l13 = line([-9.29, -61.1], [17.71, -61.1]);
    vertical(l11);
    coincident(l12.start(), l11.end());
    coincident(l13.start(), l12.end());
    horizontal(l13);
    coincident(l13.end(), l11.start());
    distance(l11.start(), l11.end(), 22);
    distance(l13.start(), l13.end(), 27);
    distance(l11.start(), xAxis(), 60);
    distance(yAxis(), l13.end(), (76+18)/2);

  });
  const f = cut().symmetric();
  repeat('mirror', 'yz', f);
  fillet(10, f.internalEdges(edge().verticalTo('xz')), select(edge().onPlane(e4.endFaces()).below('yz')));
  connector('c2', select(edge().arc(27).onPlane(e5.startFaces())).center()).offset(0, 0, 16);

  connector('c1', c.startEdges(edge().below('yz')).center());
  color('#a4aab2');

}).name('Connecting Rod Cap');
