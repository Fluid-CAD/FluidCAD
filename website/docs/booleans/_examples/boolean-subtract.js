import { sketch, circle, extrude, subtract } from 'fluidcad/core';

// A hub with a bore: the bore is a second solid subtracted from the hub.
sketch("xy", () => { circle([0, 0], 60); });
const hub = extrude(30);

// The bore as a body: taller than the hub so it cuts clean through, kept
// separate with .new() so it does not fuse into the hub first.
sketch("xy", () => { circle([0, 0], 20); });
const bore = extrude(40).new();

// highlight-start
// Keep the hub, remove the bore's volume — the Subtract tab with the hub as
// Base and the bore as Tool.
subtract(hub, bore);
// highlight-end
