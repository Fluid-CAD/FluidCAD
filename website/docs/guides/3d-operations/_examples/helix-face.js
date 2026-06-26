import { cylinder, select, helix } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

cylinder(15, 60);

helix(select(face().cylinder())).turns(6);
