// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { DofStatus } from '../src/ui/dof-status';

// The DOF pill names the misclosure when exactly one mate fails; with
// several it keeps the count and the expansion lists each mate's gap.

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const select = vi.fn();
  const status = new DofStatus(host, select);
  status.show();
  return { host, status, select };
}

describe('DOF pill — failing-mate misclosure', () => {
  it('a single failing mate puts its gap in the pill label', () => {
    const { host, status } = mount();
    status.update({
      result: 'inconsistent', dof: 1,
      failed: [{ mateId: 'm1', label: 'fastened Pin ↔ Rod', detail: '6.0 mm gap along Y' }],
    });
    expect(host.textContent).toContain('Inconsistent — 1 mate failing · 6.0 mm gap along Y');
  });

  it('a single failing mate without a known gap keeps the bare count', () => {
    const { host, status } = mount();
    status.update({ result: 'inconsistent', dof: 1, failed: [{ mateId: 'm1', label: 'fastened Pin ↔ Rod' }] });
    expect(host.textContent).toContain('Inconsistent — 1 mate failing');
    expect(host.textContent).not.toContain('·');
  });

  it('several failing mates keep the count in the pill and list each gap in the expansion', () => {
    const { host, status, select } = mount();
    status.update({
      result: 'inconsistent', dof: 0,
      failed: [
        { mateId: 'm1', label: 'fastened Pin ↔ Rod', detail: '6.0 mm gap along Y' },
        { mateId: 'm2', label: 'revolute Cap ↔ Crank', detail: '2.5° tilt' },
      ],
    });
    const pill = host.querySelector<HTMLElement>('.rounded-full')!;
    expect(pill.textContent).toContain('Inconsistent — 2 mates failing');
    expect(pill.textContent).not.toContain('gap');
    pill.click();
    const details = Array.from(host.querySelectorAll<HTMLElement>('[data-failure-detail]')).map(el => el.textContent);
    expect(details).toEqual(['6.0 mm gap along Y', '2.5° tilt']);
    host.querySelector<HTMLElement>('[data-mate-id="m2"]')!.click();
    expect(select).toHaveBeenCalledWith('m2');
  });
});
