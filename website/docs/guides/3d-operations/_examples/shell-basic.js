import { cylinder, select, shell } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

cylinder(50, 100)

select(face().circle())

shell(-5)
