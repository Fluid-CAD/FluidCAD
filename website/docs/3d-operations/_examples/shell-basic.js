import { cylinder, select, shell } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

// A Ø50 cylinder, 100 tall — no sketch needed for a primitive.
cylinder(50, 100)

// Select the flat circular faces (top and bottom) — the Shell tool writes
// this select() when the picked faces match a filter.
select(face().circle())

// Hollow the cylinder with 5-thick walls, removing the selected faces.
// Negative: the walls grow inward and the outside stays Ø50.
shell(-5)
