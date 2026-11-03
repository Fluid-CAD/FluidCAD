import { defineAssembly } from 'fluidcad/sdk';
import { Crate } from '../features/lib/crate.js';

// The generator shared beside its definition: a class, never called.
export { Crate };

export const crate = defineAssembly(Crate, {
  label: 'Crate',
  description: 'A crate with a hinged lid.',
  icon: '../features/icons/crate.svg',
});
