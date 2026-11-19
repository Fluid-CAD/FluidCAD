// The scene references' palette (docs/agent-chat-plan.md §11.2): one colour
// per reference in a message, used for the chip's swatch, the capture's
// overlay and the name the agent reads (`color="red"`). The names are fixed;
// the hex values were checked on real captures in both scene themes, against
// each other and against the body colours.

export type ReferenceColor = { name: string; hex: string };

/** In order of use: reference [1] is red, [2] blue, … */
export const REFERENCE_COLORS: readonly ReferenceColor[] = Object.freeze([
  { name: 'red', hex: '#e5484d' },
  { name: 'blue', hex: '#2f6ff0' },
  { name: 'green', hex: '#2fa84f' },
  { name: 'magenta', hex: '#d63fc0' },
  { name: 'cyan', hex: '#0fb5c9' },
  { name: 'yellow', hex: '#f2cf14' },
  { name: 'orange', hex: '#f27a12' },
  { name: 'purple', hex: '#7c4ddb' },
]);

/** References per message: one colour each, never repeated. */
export const MAX_REFERENCES = REFERENCE_COLORS.length;

/** The colour of reference `n` (1-based). */
export function referenceColor(n: number): ReferenceColor {
  return REFERENCE_COLORS[(n - 1) % REFERENCE_COLORS.length];
}
