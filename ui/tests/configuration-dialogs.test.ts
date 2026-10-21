// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The configuration band's own dialogs (docs/assembly-configurations-plan.md
// §3.4): the row-name prompt — its checks, a server refusal kept on screen —
// and the confirm before a row is deleted. (A switch asks nothing: a value
// edited in the panel is already written into its row.)

import {
  configurationNameProblem,
  confirmConfigurationDelete,
  promptConfigurationName,
} from '../src/ui/configuration-dialogs';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.innerHTML = '';
});

function ref<T extends HTMLElement>(name: string): T {
  return document.querySelector<T>(`[data-configuration-prompt] [data-ref="${name}"]`)!;
}

describe('configurationNameProblem', () => {
  it('refuses empty, reserved and repeated names; a rename may keep its own', () => {
    expect(configurationNameProblem('', [])).toBe('Enter a name.');
    expect(configurationNameProblem('Default', [])).toContain('reserved');
    expect(configurationNameProblem('Wide', ['Wide'])).toContain('already exists');
    expect(configurationNameProblem('Wide', ['Wide'], 'Wide')).toBeNull();
    expect(configurationNameProblem('Narrow', ['Wide'])).toBeNull();
  });
});

describe('promptConfigurationName', () => {
  it('submits the trimmed name and closes once it lands', async () => {
    const submit = vi.fn().mockResolvedValue(null);
    const done = promptConfigurationName(document.body, { title: 'Add configuration', confirmLabel: 'Add', taken: [], submit });
    expect(ref('title').textContent).toBe('Add configuration');
    expect(ref('ok').textContent).toBe('Add');
    ref<HTMLInputElement>('name').value = '  Wide ';
    ref('ok').click();
    await done;
    expect(submit).toHaveBeenCalledWith('Wide');
    expect(document.querySelector('[data-configuration-prompt]')).toBeNull();
  });

  it('keeps the prompt open with the reason — its own check or the server\'s', async () => {
    const submit = vi.fn().mockResolvedValueOnce('the table is not a literal').mockResolvedValueOnce(null);
    const done = promptConfigurationName(document.body, { title: 'Add', confirmLabel: 'Add', taken: ['Wide'], submit });
    ref<HTMLInputElement>('name').value = 'Wide';
    ref('ok').click();
    await flush();
    expect(submit).not.toHaveBeenCalled();
    expect(ref('message').textContent).toContain('already exists');

    ref<HTMLInputElement>('name').value = 'Narrow';
    ref('ok').click();
    await flush();
    expect(ref('message').textContent).toBe('the table is not a literal');
    expect(ref('message').classList.contains('hidden')).toBe(false);

    ref('ok').click();
    await done;
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('a rename starts from the row\'s name and closes untouched without submitting', async () => {
    const submit = vi.fn();
    const done = promptConfigurationName(document.body, { title: 'Rename', confirmLabel: 'Rename', initial: 'Wide', taken: ['Wide'], submit });
    expect(ref<HTMLInputElement>('name').value).toBe('Wide');
    ref('ok').click();
    await done;
    expect(submit).not.toHaveBeenCalled();
  });

  it('Escape cancels', async () => {
    const submit = vi.fn();
    const done = promptConfigurationName(document.body, { title: 'Add', confirmLabel: 'Add', taken: [], submit });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await done;
    expect(submit).not.toHaveBeenCalled();
    expect(document.querySelector('[data-configuration-prompt]')).toBeNull();
  });
});

describe('confirmConfigurationDelete', () => {
  const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-configuration-choice] [data-choice]'));

  it('the delete confirm resolves true only on Delete', async () => {
    const yes = confirmConfigurationDelete(document.body, 'Wide');
    buttons().find((b) => b.dataset.choice === 'delete')!.click();
    expect(await yes).toBe(true);
    const no = confirmConfigurationDelete(document.body, 'Wide');
    buttons().find((b) => b.dataset.choice === 'cancel')!.click();
    expect(await no).toBe(false);
  });
});
