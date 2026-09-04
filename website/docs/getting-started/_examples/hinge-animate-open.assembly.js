// @screenshot view iso-ftr noAxes
import { insert, mate } from 'fluidcad/core';
import { fixedLeaf } from './hinge-leaf-fixed.part.js';
import { swingLeaf } from './hinge-leaf-swing.part.js';
import { pin } from './hinge-pin.part.js';

const fixed = insert(fixedLeaf).grounded();
// The swing leaf starts turned 90° about the pin axis: a revolute joint
// leaves that rotation free, so the solver keeps the angle you insert at.
const swing = insert(swingLeaf).translate(-45, 0, 25).rotate('y', -90);
const hingePin = insert(pin).translate(0, -30, 40);

// Revolute dialog: the two 'knuckle' connectors share the pin axis and the
// swing leaf turns about it. Flip keeps the leaves side by side (without it
// the frames face each other and the leaf lands folded over); the limits
// stop the swing at flat (0°) and fully closed (180°).
mate('revolute', fixed.connectors.knuckle, swing.connectors.knuckle).flip().limits(0, 180);

// Fastened dialog: the pin's head frame is locked to the tube's end frame,
// flipped so the shaft runs into the knuckles rather than away from them.
mate('fastened', fixed.connectors.pin, hingePin.connectors.shaft).flip();
