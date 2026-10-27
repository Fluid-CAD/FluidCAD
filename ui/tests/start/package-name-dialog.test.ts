// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { PackageNameDialog } from '../../src/start/package-name-dialog';

/**
 * The desktop app's New Package asks the name here before its native folder
 * dialog: the whole `@handle/name`, with the hint about the handle.
 */

function mount() {
  const dialog = new PackageNameDialog();
  document.body.appendChild(dialog.element);
  const q = <T extends HTMLElement>(name: string) => dialog.element.querySelector<T>(`[data-ref="${name}"]`)!;
  const typeName = (value: string) => {
    q<HTMLInputElement>('name').value = value;
    q<HTMLInputElement>('name').dispatchEvent(new Event('input'));
  };
  return { dialog, q, typeName };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('PackageNameDialog', () => {
  it('asks for @handle/name with the hint, and answers with the name once it fits', async () => {
    const { dialog, q, typeName } = mount();
    const answer = dialog.ask();
    expect(dialog.isOpen()).toBe(true);
    expect(dialog.element.textContent).toContain('New package');
    expect(q('hint').textContent).toBe('The part before the slash is your hub handle; the part after it names the package.');
    expect(q<HTMLInputElement>('name').placeholder).toBe('@handle/name');
    expect(document.activeElement).toBe(q('name'));
    expect(q<HTMLButtonElement>('create').disabled).toBe(true);
    expect(q('problem').classList.contains('hidden')).toBe(true);

    typeName('@acme/Kit');
    expect(q('problem').classList.contains('hidden')).toBe(false);
    expect(q('problem').textContent).toContain('A package name is @handle/name');
    expect(q<HTMLButtonElement>('create').disabled).toBe(true);

    typeName(' @acme/kit ');
    expect(q('problem').classList.contains('hidden')).toBe(true);
    expect(q<HTMLButtonElement>('create').disabled).toBe(false);
    q<HTMLButtonElement>('create').click();
    expect(await answer).toBe('@acme/kit');
    expect(dialog.isOpen()).toBe(false);
  });

  it('answers on Enter, and says what is wrong when Enter comes too early', async () => {
    const { dialog, q, typeName } = mount();
    const answer = dialog.ask();
    q('name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(q('problem').classList.contains('hidden')).toBe(false);
    expect(dialog.isOpen()).toBe(true);
    typeName('@acme/kit');
    q('name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(await answer).toBe('@acme/kit');
  });

  it('answers null on Cancel, the close button, the backdrop and Escape', async () => {
    const { dialog, q } = mount();
    let answer = dialog.ask();
    q<HTMLButtonElement>('cancel').click();
    expect(await answer).toBeNull();
    answer = dialog.ask();
    q<HTMLButtonElement>('close').click();
    expect(await answer).toBeNull();
    answer = dialog.ask();
    dialog.element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(await answer).toBeNull();
    answer = dialog.ask();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await answer).toBeNull();
    expect(dialog.isOpen()).toBe(false);
  });

  it('starts empty every time, and a second ask settles the first with nothing', async () => {
    const { dialog, q, typeName } = mount();
    const first = dialog.ask();
    typeName('@acme/kit');
    const second = dialog.ask();
    expect(await first).toBeNull();
    expect(q<HTMLInputElement>('name').value).toBe('');
    typeName('@acme/other');
    q<HTMLButtonElement>('create').click();
    expect(await second).toBe('@acme/other');
  });
});
