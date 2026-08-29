// fluidcad/shapes — macro shape statements: each call is ONE atomic,
// self-constrained unit (internal solver rules, no constraint statements).
// Code-only sugar: the UI drawing tools keep emitting primitives +
// explicit constraints; these are for hand-written models.

export { default as rect } from './rect.js';
