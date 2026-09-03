import { describe, expect, it } from 'vitest';
import { normalizeAssemblyPayload } from '../src/scene/assembly-payload';
import type { SerializedAssembly } from '../src/types';

// The scene-rendered handler rebuilds the assembly payload field by field.
// Every list must survive the rebuild — the occurrences list once didn't,
// and the parts panel silently stopped grouping sub-assemblies.

describe('normalizeAssemblyPayload', () => {
  it('carries every list through, replicates included', () => {
    const raw: SerializedAssembly = {
      instances: [{ instanceId: 'inst-0' } as SerializedAssembly['instances'][number]],
      mates: [{ mateId: 'mate-0' } as SerializedAssembly['mates'][number]],
      occurrences: [{ occurrenceId: 'asm-0' } as NonNullable<SerializedAssembly['occurrences']>[number]],
      connectors: [{ connectorId: 'w-0' } as NonNullable<SerializedAssembly['connectors']>[number]],
      replicates: [{ replicateId: 'rep-0' } as NonNullable<SerializedAssembly['replicates']>[number]],
    };
    const out = normalizeAssemblyPayload(raw);
    expect(out).toEqual(raw);
    // Every key the wire type declares is present in the rebuild.
    for (const key of Object.keys(raw) as (keyof SerializedAssembly)[]) {
      expect(out[key]).toBe(raw[key]);
    }
  });

  it('reads an older engine\'s missing lists as empty', () => {
    expect(normalizeAssemblyPayload({ instances: [], mates: [] })).toEqual({
      instances: [],
      mates: [],
      occurrences: [],
      connectors: [],
      replicates: [],
    });
    expect(normalizeAssemblyPayload(undefined).replicates).toEqual([]);
  });
});
