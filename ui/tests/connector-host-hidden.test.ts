// A connector goes with its body: the viewer hides it when the shapes panel
// hides the solid it sits on, and only then — a connector on a plane or a
// bare point has no host and follows the global toggle alone.
import { describe, it, expect } from 'vitest';
import { connectorHostHidden } from '../src/scene/connector-host';

describe('connectorHostHidden', () => {
  it('hides a connector whose host body is hidden', () => {
    expect(connectorHostHidden(['solid-1'], new Set(['solid-1']))).toBe(true);
  });

  it('keeps a connector whose host body is shown', () => {
    expect(connectorHostHidden(['solid-1'], new Set(['solid-2']))).toBe(false);
  });

  it('never host-hides a connector without a host', () => {
    expect(connectorHostHidden(undefined, new Set(['solid-1']))).toBe(false);
    expect(connectorHostHidden([], new Set(['solid-1']))).toBe(false);
  });

  it('hides a split host only once every piece is hidden', () => {
    expect(connectorHostHidden(['a', 'b'], new Set(['a']))).toBe(false);
    expect(connectorHostHidden(['a', 'b'], new Set(['a', 'b']))).toBe(true);
  });
});
