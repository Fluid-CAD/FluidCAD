// The name a property takes from its label — the same derivation the server
// applies to a parameter's variable, so the read-only Name field previews
// exactly what the file will say.

import { describe, expect, it } from 'vitest';
import { identifierFromLabel } from '../src/ui/label-identifier';

describe('identifierFromLabel', () => {
  it('camel-cases the words of a label', () => {
    expect(identifierFromLabel('Wall thickness')).toBe('wallThickness');
    expect(identifierFromLabel('pocket   diameter (mm)')).toBe('pocketDiameterMm');
    expect(identifierFromLabel('boltCount')).toBe('boltCount');
    expect(identifierFromLabel('Width')).toBe('width');
  });

  it('puts a letter in front of a name that cannot start a declaration', () => {
    expect(identifierFromLabel('2nd width')).toBe('p2ndWidth');
    expect(identifierFromLabel('delete')).toBe('pdelete');
    expect(identifierFromLabel('!!!')).toBe('p');
  });
});
