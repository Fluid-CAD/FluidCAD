// @screenshot view iso-ftr
import { select, sketch, extrude, circle, line } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { coincident, diameter, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// A Ø80 pipe running left to right, 140 mm in front of the origin.
sketch("yz", () => {
    const c = circle([-140, 60], 80);
    fix(c.center(), [-140, 60]);
    diameter(c, 80);
  })
extrude(200).symmetric()

// The face to stop at — the pipe's curved wall.
// highlight-next-line
const pipeWall = select(face().cylinder())

// The bracket profile: a flat 60 x 80 rectangle on the front plane, whose
// normal points at the pipe.
sketch("front", () => {
    const sg1 = line([-30, 20], [30, 20]);
    const sg2 = line([30, 20], [30, 100]);
    const sg3 = line([30, 100], [-30, 100]);
    const sg4 = line([-30, 100], [-30, 20]);
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-30, 20]);
    distance(sg1.start(), sg1.end(), 60);
    distance(sg2.start(), sg2.end(), 80);
  })

// The extrusion stops on the pipe: its end face is a slice of the pipe's
// cylinder, so the bracket lands tangent to it instead of clipping it.
// highlight-next-line
extrude(pipeWall);
