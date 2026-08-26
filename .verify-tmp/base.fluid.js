import { slot,plane, revolve, circle, connector, expose, cut, breakpoint, trim, aLine, line, vLine, hLine, move, extrude, rect, sketch, mirror, axis, connect, part, remove, color } from 'fluidcad/core';
import {edge, face } from 'fluidcad/filters';

export const p1 = part("Base", () => {
    sketch('xy', () => {
        rect(112, 102).centered()
    });
    extrude(12);

    sketch('xz', () => {
        rect([0, 12], 16, 166).centered('horizontal')
    });
    const e3 = extrude(18).symmetric();

    sketch('xz', () => {
        rect([-8, 178], 16, -22)
    });

    extrude(250).symmetric();

    const s = sketch('xz', () => {
        const r = rect([-8, 178], 16, -22).guide()
        move(0, 11)
        const g = hLine(-8).guide()
        const l1 = vLine(7.25)
        const l2 = aLine(-90 - 18, r)

        mirror(g, l1, l2)

        line(l2.end())
        rect([8, 178 - 3], 12, -16)

    }).reusable();

    const c = cut().symmetric();

    const s2 = sketch('xz', () => {
        rect([8, 72], 12, 4)
    });

    const a = axis("x", { offsetZ: 72 })

    const rev = revolve(a);


    connector('c1', c.internalFaces(face().parallelTo('yz')).center()).rotate('y', 270);

    connector('c2', rev.sideFaces(2).center());
    expose('dovetailSketch', s);
    sketch(e3.sideFaces(3), () => {
      circle([20, 0], 8)

    });
    const e4 = extrude(20);
    expose('g1', e4.endFaces());
    connector('c3', e4.endFaces().center());

    color('white')
})

export const p2 = part("Slider", () => {

    const e = extrude(22, p1.features.dovetailSketch).symmetric()

    remove(p1.features.dovetailSketch)
    connector('c1', e.sideFaces(face().onPlane('yz')).center()).rotate('y', 90)
    sketch(e.sideFaces(6), () => {
        circle(8)

    })

    const e7 = extrude(10)
    expose('g1', e7.sideFaces())

    color('orange')
});

export const part1 = part('Disc', () => {
    const p = plane('yz', 20);

    sketch(p, () => {
      move(0, 72)
      circle(36*2)
      move(0, -0)
      circle(8)

    });

    const e2 = extrude(-8);
    sketch(e2.startFaces(), () => {
      move(0, 36-4)
      circle([0, 102], 8)

    });

    const e6 = extrude(10);

    connector('c1', e2.startEdges(1).center());
    expose('g1', e6.sideFaces());

    color('white')
});
export const part12 = part('Arm', () => {
  sketch(p1.features.g1, () => {
    slot(185, 8)
    circle(8)
    slot([105, 0], -65, 4)
  });

  const e5 = extrude(-5);
  sketch(e5.startFaces(), () => {
    move(47, 0)
    rect(60, 8).centered('vertical')
    circle(8)

  });

  const c2 = cut().scope(e5);
  connector('c1', e5.startEdges(edge().circle()).center());
  expose('g1', e5.internalFaces(1));
  expose('g2', c2.internalFaces(1));
  expose('g3', e5.internalFaces(4));
  expose('g4', c2.internalFaces(face().below('xz')));

    color('#31a4e2')
});

