// @screenshot view iso-ftr
import { insert } from 'fluidcad/core';
import { fixedLeaf } from './hinge-leaf-fixed.part.js';
import { swingLeaf } from './hinge-leaf-swing.part.js';
import { pin } from './hinge-pin.part.js';

// Insert dialog: one instance of each part. The fixed leaf is grounded (it
// stays where it is); the others were dragged aside with the gizmo, which
// wrote the .translate() chains.
const fixed = insert(fixedLeaf).grounded();
const swing = insert(swingLeaf).translate(-45, 0, 25);
const hingePin = insert(pin).translate(0, -30, 40);
