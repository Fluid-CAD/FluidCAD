// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoldingSection } from '../../src/ui/controls';

// A heading that folds what sits under it: a button with aria-expanded over
// a body that hides, telling its caller only when the user did it.

describe('a folding section', () => {
  const roots: HTMLElement[] = [];
  const build = (opts: ConstructorParameters<typeof FoldingSection>[0]) => {
    const section = new FoldingSection(opts);
    document.body.appendChild(section.root);
    roots.push(section.root);
    const heading = section.root.querySelector<HTMLButtonElement>('[data-role="section-toggle"]')!;
    return { section, heading };
  };

  afterEach(() => {
    roots.splice(0).forEach(root => root.remove());
  });

  it('opens unfolded: a button heading that says so over a body that shows', () => {
    const { section, heading } = build({ title: 'Depth', headingClass: 'text-xs', columnClass: 'flex flex-col' });
    expect(heading.type).toBe('button');
    expect(heading.textContent).toBe('Depth');
    expect(heading.className).toContain('text-xs');
    expect(heading.getAttribute('aria-expanded')).toBe('true');
    expect(section.folded).toBe(false);
    expect(section.root.className).toBe('flex flex-col');
    expect(section.body.className).toBe('flex flex-col');
    expect([...section.root.children]).toEqual([heading, section.body]);
  });

  it('starts folded when asked, and folds and unfolds from its heading, telling the caller', () => {
    const { section, heading } = build({ title: 'Finish', folded: true });
    const toggled = vi.fn();
    section.onToggle = toggled;
    expect(section.folded).toBe(true);
    expect(heading.getAttribute('aria-expanded')).toBe('false');
    expect(section.body.classList.contains('hidden')).toBe(true);
    heading.click();
    expect(section.folded).toBe(false);
    expect(heading.getAttribute('aria-expanded')).toBe('true');
    expect(section.body.classList.contains('hidden')).toBe(false);
    heading.click();
    expect(section.body.classList.contains('hidden')).toBe(true);
    expect(toggled.mock.calls).toEqual([[false], [true]]);
  });

  it("says nothing of a fold the caller makes itself", () => {
    const { section, heading } = build({ title: 'Finish' });
    const toggled = vi.fn();
    section.onToggle = toggled;
    section.setFolded(true);
    expect(heading.getAttribute('aria-expanded')).toBe('false');
    expect(section.body.classList.contains('hidden')).toBe(true);
    expect(toggled).not.toHaveBeenCalled();
  });
});
