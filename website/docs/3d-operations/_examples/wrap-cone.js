import { sketch, plane, line, arc, revolve, select, wrap } from 'fluidcad/core';
import { coincident, horizontal, tangent, equal, radius, fix } from 'fluidcad/constraints';
import { face } from 'fluidcad/filters';

sketch("xz", () => {
    const b = line([0, 0], [30, 0]);
    const s = line([30, 0], [20, 50]);
    const t = line([20, 50], [0, 50]);
    const l = line([0, 50], [0, 0]);
    coincident(b.end(), s.start());
    coincident(s.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
  });
revolve("z");

const target = select(face().cone());

const decal = sketch(plane("front", 26), () => {
    // A slot profile: two parallel lines closed by semicircular caps.
    const bottom = line([-8, 21], [8, 21]);
    const capR = arc([8, 21], [8, 29], [8, 25]);
    const top = line([8, 29], [-8, 29]);
    const capL = arc([-8, 29], [-8, 21], [-8, 25]);
    coincident(bottom.end(), capR.start());
    coincident(capR.end(), top.start());
    coincident(top.end(), capL.start());
    coincident(capL.end(), bottom.start());
    horizontal(bottom);
    horizontal(top);
    tangent(bottom, capR);
    tangent(top, capL);
    equal(capR, capL);
    radius(capR, 4);
  });

wrap(1.5, decal, target);
