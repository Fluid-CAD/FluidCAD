import { aLine, arc, circle, color, connect, copy, cut, extrude, fillet, fuse, hLine, hMove, mirror, move, plane, project, rect, remove, repeat, rotate, select, shell, sketch, slot, tArc, tLine, vMove, wire } from "fluidcad/core";
import { enclosed, enclosing, outside } from "fluidcad/constraints";
import { edge, face } from "fluidcad/filters";

rect(120, 66, "top").centered().radius(13)
let e = extrude(13)
