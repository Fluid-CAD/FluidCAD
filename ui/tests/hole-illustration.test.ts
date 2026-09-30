import { describe, expect, it } from 'vitest';
import { holeIllustration, type HoleIllustrationOptions } from '../src/interactive/create-feature/hole/hole-illustration';

// The Hole dialog's section drawing: the plate outline follows the style and
// termination, and only a dimension the current options actually have is
// drawn in the primary colour.

const BASE: HoleIllustrationOptions = { style: 'simple', through: true, tip: false, highlight: null };

/** The dimension group's inner markup (arrows, labels) — empty when nothing is highlighted. */
function dimensionMarkup(options: HoleIllustrationOptions): string {
  const svg = holeIllustration(options);
  const match = /<g fill="var\(--color-primary\)"[^>]*>(.*?)<\/g>/s.exec(svg);
  return match ? match[1] : '';
}

describe('hole illustration', () => {
  it('draws one outline for a blind hole and two for a through hole', () => {
    const through = holeIllustration(BASE);
    const blind = holeIllustration({ ...BASE, through: false });
    const outlines = (svg: string) => (svg.match(/fill="currentColor" fill-opacity/g) ?? []).length;
    expect(outlines(through)).toBe(2);
    expect(outlines(blind)).toBe(1);
    expect(through).toContain('<svg');
    expect(through).toContain('stroke="currentColor"');
  });

  it('adds the drill point only to a blind hole with a tip', () => {
    const flat = holeIllustration({ ...BASE, through: false, tip: false });
    const tipped = holeIllustration({ ...BASE, through: false, tip: true });
    // The tipped profile has one more point on the axis below the floor.
    expect(tipped.length).toBeGreaterThan(flat.length);
    // Marker ids differ per drawing; the geometry does not.
    const geometry = (svg: string) => svg.replace(/hole-dim-\d+/g, 'hole-dim');
    expect(geometry(holeIllustration({ ...BASE, through: true, tip: true })))
      .toBe(geometry(holeIllustration({ ...BASE, through: true, tip: false })));
  });

  it('highlights the diameter with a double arrow and the Ø label', () => {
    const markup = dimensionMarkup({ ...BASE, highlight: 'diameter' });
    expect(markup).toContain('marker-start');
    expect(markup).toContain('⌀');
  });

  it('draws the depth and tip angle only for a blind hole', () => {
    expect(dimensionMarkup({ ...BASE, highlight: 'depth' })).toBe('');
    expect(dimensionMarkup({ ...BASE, through: false, highlight: 'depth' })).toContain('depth');
    expect(dimensionMarkup({ ...BASE, through: false, tip: false, highlight: 'tipAngle' })).toBe('');
    expect(dimensionMarkup({ ...BASE, through: false, tip: true, highlight: 'tipAngle' })).toContain('tip');
  });

  it('draws counterbore and countersink dimensions only for their style', () => {
    expect(dimensionMarkup({ ...BASE, highlight: 'counterboreDiameter' })).toBe('');
    expect(dimensionMarkup({ ...BASE, style: 'counterbore', highlight: 'counterboreDiameter' })).toContain('⌀');
    expect(dimensionMarkup({ ...BASE, style: 'counterbore', highlight: 'counterboreDepth' })).toContain('depth');
    expect(dimensionMarkup({ ...BASE, style: 'counterbore', highlight: 'countersinkAngle' })).toBe('');
    expect(dimensionMarkup({ ...BASE, style: 'countersink', highlight: 'countersinkDiameter' })).toContain('⌀');
    expect(dimensionMarkup({ ...BASE, style: 'countersink', highlight: 'countersinkAngle' })).toContain('angle');
  });

  it('gives every drawing its own marker ids so several can share a document', () => {
    const a = holeIllustration({ ...BASE, highlight: 'diameter' });
    const b = holeIllustration({ ...BASE, highlight: 'diameter' });
    const idOf = (svg: string) => /id="(hole-dim-\d+)-start"/.exec(svg)?.[1];
    expect(idOf(a)).toBeDefined();
    expect(idOf(a)).not.toBe(idOf(b));
  });
});
