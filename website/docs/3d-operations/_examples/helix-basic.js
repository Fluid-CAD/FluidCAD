import { helix } from 'fluidcad/core';

// A helical wire around the Z axis: radius 15, rising 10 per turn, 4 turns
// (so 40 tall). On its own it is a curve; sweep a profile along it for material.
helix("z").radius(15).pitch(10).turns(4);
