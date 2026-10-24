// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublishDialog, RELEASE_NOTES_CHARS } from '../src/ui/publish/publish-dialog';
import { PublishState, PublishText } from '../src/ui/publish/publish-state';
import { FakePublishClient, HUB } from './fixtures/fake-publish-client';
import { settle } from './fixtures/fake-packages-client';

// The Publish dialog (ui-packages-plan N4, U6–U10): `fluidcad publish` as
// a dialog over the engine's publish session. The block problem first
// (U7), signed out with the Hub panel's Sign in, the header with the bump
// control, the hub's status line, the release notes once a version was
// published, Check / Publish → the summary → Upload → the progress → the
// result (a first version's wizard opened once, U9), the refusals with
// their actions, the after-state from the status.

const opened: PublishDialog[] = [];

afterEach(() => {
  for (const dialog of opened.splice(0)) {
    dialog.destroy();
  }
  document.body.innerHTML = '';
});

/** Timers the test fires by hand: the session's polling. */
class ManualTimers {
  pending: { callback: () => void; ms: number }[] = [];
  set = (callback: () => void, ms: number): unknown => {
    const entry = { callback, ms };
    this.pending.push(entry);
    return entry;
  };
  clear = (handle: unknown): void => {
    this.pending = this.pending.filter((entry) => entry !== handle);
  };
  /** One poll. */
  async fire(): Promise<void> {
    for (const entry of this.pending.splice(0)) {
      entry.callback();
    }
    await settle();
  }
}

/** An element's words: its text nodes joined by one space (adjacent buttons read apart), the icons' markup whitespace folded away. */
const words = (el: Element | null): string | null => {
  if (!el) {
    return null;
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    parts.push(node.textContent ?? '');
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};

async function mount(setup: (client: FakePublishClient) => void = () => {}, { show = true } = {}) {
  const client = new FakePublishClient();
  setup(client);
  const timers = new ManualTimers();
  const state = new PublishState(client, { hubUrl: async () => HUB, timers });
  let settleSignIn: (signedIn: boolean) => void = () => {};
  const signIn = vi.fn(() => new Promise<boolean>((resolve) => {
    settleSignIn = resolve;
  }));
  const openExternal = vi.fn();
  const onVersionChanged = vi.fn();
  const dialog = new PublishDialog(document.body, { state, signIn, openExternal, onVersionChanged });
  opened.push(dialog);
  if (show) {
    dialog.show();
    await settle();
  }
  const overlays = document.body.querySelectorAll<HTMLElement>('[data-role="publish"]');
  const overlay = overlays[overlays.length - 1];
  const $ = <T extends HTMLElement = HTMLElement>(ref: string) => overlay.querySelector<T>(`[data-ref="${ref}"]`);
  const shown = (ref: string) => {
    const el = $(ref);
    return el !== null && !el.classList.contains('hidden');
  };
  const click = async (ref: string) => {
    const el = $<HTMLButtonElement>(ref);
    if (!el) {
      throw new Error(`no [data-ref="${ref}"]`);
    }
    el.click();
    await settle();
  };
  return { client, state, timers, dialog, overlay, $, shown, click, signIn, settleSignIn: (v: boolean) => settleSignIn(v), openExternal, onVersionChanged };
}

/** Start a publish and let the engine pack it up to the summary. */
async function toSummary(h: Awaited<ReturnType<typeof mount>>, summary = FakePublishClient.summary()) {
  await h.click('publish');
  h.client.advance({ status: 'awaiting-confirm', summary, confirmBy: '2026-10-24T12:10:00.000Z' });
  await h.timers.fire();
}

describe('opening', () => {
  it('shows the package, its version and that it is not on the hub yet; Check and Publish; no notes field', async () => {
    const h = await mount();
    expect(h.dialog.isOpen()).toBe(true);
    expect(h.$('title')!.textContent).toBe('Publish @acme/kit');
    expect(h.$('name')!.textContent).toBe('@acme/kit');
    expect(h.$('version')!.textContent).toBe('0.1.0');
    expect(h.$('hub-status')!.dataset.state).toBe('known');
    expect(words(h.$('not-on-hub'))).toBe('@acme/kit is not on http://localhost:8787 yet. Publish uploads its first version.');
    expect(h.shown('check')).toBe(true);
    expect(h.shown('publish')).toBe(true);
    expect(h.$('publish')!.textContent).toBe('Publish');
    expect(h.shown('notes')).toBe(false);
    expect(h.shown('session')).toBe(false);
    expect(h.shown('problem')).toBe(false);
    expect(h.client.packageInfo).toHaveBeenCalledTimes(1);
    expect(h.client.status).toHaveBeenCalledTimes(1);
    expect(h.client.current).toHaveBeenCalledTimes(1);
  });

  it('a block the engine cannot read opens on its problem and nothing else (U7)', async () => {
    const problem = 'fluidcad.json has a "package" whose "name" "kit" needs your hub handle as its scope: write "@<your-handle>/kit".';
    const h = await mount((client) => {
      client.packageValue = { package: null, problem };
    });
    expect(h.$('title')!.textContent).toBe('Publish');
    expect(h.shown('problem')).toBe(true);
    expect(h.$('problem')!.dataset.code).toBe('bad-config');
    expect(h.$('problem-text')!.textContent).toBe(problem);
    expect(words(h.$('problem'))).toContain('Fix fluidcad.json, then try again.');
    expect(h.shown('version-row')).toBe(false);
    expect(h.shown('hub-status')).toBe(false);
    expect(h.shown('check')).toBe(false);
    expect(h.shown('publish')).toBe(false);
    expect(h.shown('retry')).toBe(true);
    // No hub request for a package that can't be named.
    expect(h.client.status).not.toHaveBeenCalled();

    // Fixed on disk: Try again reads it.
    h.client.packageValue = { package: { name: '@acme/kit', version: '0.1.0' }, problem: null };
    await h.click('retry');
    expect(h.shown('problem')).toBe(false);
    expect(h.$('name')!.textContent).toBe('@acme/kit');
    expect(h.shown('publish')).toBe(true);
  });

  it('a plain project (no block) says so', async () => {
    const h = await mount((client) => {
      client.packageValue = { package: null, problem: null };
    });
    expect(h.$('problem')!.dataset.code).toBe('not-a-package');
    expect(h.$('problem-text')!.textContent).toMatch(/^This workspace has no package block/);
    expect(h.shown('publish')).toBe(false);
  });

  it('the engine not answering the block is said too', async () => {
    const h = await mount((client) => {
      client.packageRefusal = { ok: false, status: 0, error: "The engine didn't answer: Failed to fetch", code: 'engine-unreachable' };
    });
    expect(h.$('problem')!.dataset.code).toBe('engine-unreachable');
    expect(h.$('problem-text')!.textContent).toBe("The engine didn't answer: Failed to fetch");
    expect(h.shown('retry')).toBe(true);
  });

  it('Escape and the backdrop close it; so does Close', async () => {
    const h = await mount();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.dialog.isOpen()).toBe(false);
    h.dialog.show();
    await settle();
    h.overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(h.dialog.isOpen()).toBe(false);
    h.dialog.show();
    await settle();
    await h.click('done');
    expect(h.dialog.isOpen()).toBe(false);
  });
});

describe('signed out', () => {
  it('shows the refusal with Sign in and no Check / Publish', async () => {
    const h = await mount((client) => {
      client.statusRefusal = FakePublishClient.signedOut();
    });
    expect(h.$('hub-status')!.dataset.state).toBe('signed-out');
    expect(words(h.$('signed-out'))).toBe('Not signed in to http://localhost:8787. Sign in to publish. Sign in');
    expect(h.shown('check')).toBe(false);
    expect(h.shown('publish')).toBe(false);
    expect(h.shown('version-row')).toBe(true);
  });

  it('Sign in hands over to the Hub panel; the dialog comes back signed in and reads the status again', async () => {
    const h = await mount((client) => {
      client.statusRefusal = FakePublishClient.signedOut();
    });
    await h.click('sign-in');
    expect(h.signIn).toHaveBeenCalledTimes(1);
    // The panel's flow owns the wait; the dialog is out of the way.
    expect(h.dialog.isOpen()).toBe(false);

    h.client.statusRefusal = null;
    h.settleSignIn(true);
    await settle();
    expect(h.dialog.isOpen()).toBe(true);
    expect(h.client.status).toHaveBeenCalledTimes(2);
    expect(h.$('hub-status')!.dataset.state).toBe('known');
    expect(h.shown('publish')).toBe(true);
  });

  it('a sign-in that ends otherwise leaves the dialog closed (the panel says why)', async () => {
    const h = await mount((client) => {
      client.statusRefusal = FakePublishClient.signedOut();
    });
    await h.click('sign-in');
    h.settleSignIn(false);
    await settle();
    expect(h.dialog.isOpen()).toBe(false);
    expect(h.client.status).toHaveBeenCalledTimes(1);
  });

  it('any other status refusal is shown with Try again, and Publish stays', async () => {
    const h = await mount((client) => {
      client.statusRefusal = { ok: false, status: 503, error: 'http://localhost:8787 did not answer.', code: 'hub-unreachable' };
    });
    expect(h.$('hub-status')!.dataset.state).toBe('unknown');
    expect(words(h.$('status-problem'))).toBe('http://localhost:8787 did not answer. Try again');
    expect(h.shown('publish')).toBe(true);
    h.client.statusRefusal = null;
    await h.click('status-retry');
    expect(h.$('hub-status')!.dataset.state).toBe('known');
  });
});

describe('the status line (fluidcad publish --status)', () => {
  it('a draft: Open the wizard, Withdraw (asked first, in the CLI\'s words), the expiry', async () => {
    const h = await mount((client) => {
      client.statusValue = FakePublishClient.onHub({ openVersion: FakePublishClient.version({ draftExpiresAt: '2026-11-23T12:00:00.000Z' }) });
    });
    expect(words(h.$('open-draft'))).toBe('@acme/kit@0.1.0 is a draft · finish publishing in your browser Open the wizard Withdraw');
    expect(words(h.$('draft-expires'))).toBe('a draft nobody touches is deleted on 2026-11-23');
    expect(words(h.$('no-version'))).toBeNull();
    await h.click('open-wizard');
    expect(h.openExternal).toHaveBeenCalledWith(`${HUB}/publish/@acme/kit/0.1.0`);

    await h.click('withdraw');
    expect(h.client.withdraw).not.toHaveBeenCalled();
    expect(words(h.$('withdraw-confirm'))).toBe(
      '@acme/kit@0.1.0 is the draft on http://localhost:8787. Withdrawing deletes it there; its number is free again. Keep it Withdraw it',
    );
    await h.click('withdraw-keep');
    expect(h.$('withdraw-confirm')).toBeNull();
    await h.click('withdraw');
    await h.click('withdraw-go');
    expect(h.client.withdraw).toHaveBeenCalledTimes(1);
    expect(h.$('withdraw-confirm')).toBeNull();
    expect(words(h.$('notice'))).toBe('Withdrew @acme/kit@0.1.0 from http://localhost:8787.');
    // The status was read again: the draft is gone.
    expect(h.client.status).toHaveBeenCalledTimes(2);
    expect(h.$('open-draft')).toBeNull();
    expect(words(h.$('no-version'))).toBe('@acme/kit has no version on http://localhost:8787 yet. Publish uploads one.');
  });

  it('in review: the date, its status page, Withdraw', async () => {
    const h = await mount((client) => {
      client.statusValue = FakePublishClient.onHub({
        openVersion: FakePublishClient.version({ version: '0.2.0', status: 'in_review', wizardUrl: null, submittedAt: '2026-10-20T08:00:00.000Z' }),
      }, FakePublishClient.version({ version: '0.1.0', status: 'published', publishedAt: '2026-10-01T08:00:00.000Z' }));
    });
    expect(words(h.$('open-in-review'))).toBe('@acme/kit@0.2.0 is in review since 2026-10-20 View its status Withdraw');
    expect(words(h.$('latest'))).toBe('latest published 0.1.0 on 2026-10-01 · sha256-abc Manage on the hub');
    await h.click('open-review');
    expect(h.openExternal).toHaveBeenCalledWith(`${HUB}/@acme/kit/status`);
    await h.click('manage');
    expect(h.openExternal).toHaveBeenLastCalledWith(`${HUB}/@acme/kit/manage`);
    await h.click('withdraw');
    expect(words(h.$('withdraw-confirm'))).toMatch(/^@acme\/kit@0\.2\.0 is in review on http:\/\/localhost:8787\./);
  });

  it('rejected: the note, then Publish again; the latest alone names the package', async () => {
    const h = await mount((client) => {
      client.statusValue = FakePublishClient.onHub({
        rejectedVersion: FakePublishClient.version({ version: '0.2.0', status: 'rejected', reviewNote: 'The README is empty.' }),
      });
    });
    expect(words(h.$('rejected'))).toBe('@acme/kit@0.2.0 was rejected: The README is empty.');
    expect(words(h.$('rejected-next'))).toBe('Fix it, then publish again (the same version number is free).');
    expect(h.$('publish')!.textContent).toBe('Publish again');

    const published = await mount((client) => {
      client.statusValue = FakePublishClient.onHub({}, FakePublishClient.version({ status: 'published', publishedAt: '2026-10-01T08:00:00.000Z' }));
    });
    expect(words(published.$('latest'))).toBe('@acme/kit: latest published 0.1.0 on 2026-10-01 · sha256-abc Manage on the hub');
    expect(published.$('publish')!.textContent).toBe('Publish');
  });

  it('a package the hub\'s admins suspended says so', async () => {
    const h = await mount((client) => {
      client.statusValue = FakePublishClient.onHub({ status: 'suspended' }, FakePublishClient.version({ status: 'published' }));
    });
    expect(words(h.$('package-status'))).toBe("the package is suspended by the hub's admins");
  });

  it('a withdraw the hub refuses is said under the body', async () => {
    const h = await mount((client) => {
      client.statusValue = FakePublishClient.onHub({ openVersion: FakePublishClient.version() });
      client.withdrawRefusal = { ok: false, status: 409, error: '@acme/kit has nothing open to withdraw.', code: 'nothing-open' };
    });
    await h.click('withdraw');
    await h.click('withdraw-go');
    expect(h.$('notice')!.dataset.code).toBe('nothing-open');
    expect(h.$('notice')!.classList.contains('text-error')).toBe(true);
  });
});

describe('the version and its bump control', () => {
  it('patch / minor / major preview the next version and write the block; the header and the overview follow', async () => {
    const h = await mount();
    const bump = (part: string) => h.overlay.querySelector<HTMLButtonElement>(`[data-bump="${part}"]`)!;
    expect(bump('patch').title).toBe('0.1.0 → 0.1.1');
    expect(bump('minor').title).toBe('0.1.0 → 0.2.0');
    expect(bump('major').title).toBe('0.1.0 → 1.0.0');
    bump('minor').click();
    await settle();
    expect(h.client.bumpVersion).toHaveBeenCalledWith('minor');
    expect(h.$('version')!.textContent).toBe('0.2.0');
    expect(h.$('title')!.textContent).toBe('Publish @acme/kit');
    expect(words(h.$('notice'))).toBe('@acme/kit is 0.2.0 now (was 0.1.0).');
    expect(h.onVersionChanged).toHaveBeenCalledTimes(1);
    expect(bump('patch').title).toBe('0.2.0 → 0.2.1');
  });

  it('an exact version: Set, or Enter in the field; a refusal is shown', async () => {
    const h = await mount();
    const input = h.$<HTMLInputElement>('version-input')!;
    input.value = '2.0.0';
    await h.click('version-set');
    expect(h.client.bumpVersion).toHaveBeenCalledWith('2.0.0');
    expect(h.$('version')!.textContent).toBe('2.0.0');
    expect(input.value).toBe('');

    input.value = 'banana';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(h.client.bumpVersion).toHaveBeenLastCalledWith('banana');
    expect(h.$('notice')!.dataset.code).toBe('refused');
    expect(words(h.$('notice'))).toMatch(/^"banana" is not a version or a bump/);
    expect(h.$('version')!.textContent).toBe('2.0.0');
    expect(h.onVersionChanged).toHaveBeenCalledTimes(1);

    // An empty field just asks for one.
    input.value = '';
    await h.click('version-set');
    expect(h.client.bumpVersion).toHaveBeenCalledTimes(2);
  });

  it('the control waits while a session runs', async () => {
    const h = await mount();
    await toSummary(h);
    expect(h.overlay.querySelector<HTMLButtonElement>('[data-bump="patch"]')!.disabled).toBe(true);
    expect(h.$<HTMLInputElement>('version-input')!.disabled).toBe(true);
    await h.click('cancel');
    expect(h.overlay.querySelector<HTMLButtonElement>('[data-bump="patch"]')!.disabled).toBe(false);
  });
});

describe('release notes', () => {
  it('appear once a version was published, with the counter and the CHANGELOG hint, and travel with Publish', async () => {
    const h = await mount((client) => {
      client.statusValue = FakePublishClient.onHub({}, FakePublishClient.version({ status: 'published' }));
      client.packageValue = { package: { name: '@acme/kit', version: '0.1.1' }, problem: null };
    });
    expect(h.shown('notes')).toBe(true);
    const field = h.$<HTMLTextAreaElement>('notes-field')!;
    expect(field.maxLength).toBe(RELEASE_NOTES_CHARS);
    expect(h.$('notes-count')!.textContent).toBe('0 / 280');
    expect(h.$('notes-hint')!.textContent).toBe('0.1.1 goes to review. Left empty, the hub takes the CHANGELOG section for 0.1.1.');
    field.value = 'Fixes the lid.';
    field.dispatchEvent(new Event('input'));
    expect(h.$('notes-count')!.textContent).toBe('14 / 280');

    await h.click('publish');
    expect(h.client.start).toHaveBeenCalledWith({ notes: 'Fixes the lid.', dryRun: false });
    // Not while the session runs.
    expect(h.shown('notes')).toBe(false);
    h.client.advance({ status: 'awaiting-confirm', summary: FakePublishClient.summary({ version: '0.1.1', becomes: 'in_review', notes: 'Fixes the lid.' }) });
    await h.timers.fire();
    expect(words(h.$('summary-notes'))).toBe('notes: Fixes the lid.');
    expect(words(h.$('becomes'))).toBe('goes straight to review: an admin approves it before it is public');
  });

  it('are not asked for a first version, and Check sends none', async () => {
    const h = await mount();
    expect(h.shown('notes')).toBe(false);
    await h.click('check');
    expect(h.client.start).toHaveBeenCalledWith({ notes: null, dryRun: true });
  });
});

describe('Check: a dry run', () => {
  it('packs, uploads and shows the CLI\'s sentence with the summary; nothing opens', async () => {
    const h = await mount();
    await h.click('check');
    expect(h.$('session')!.dataset.status).toBe('packing');
    expect(words(h.$('wait'))).toBe('Packing…');
    expect(h.shown('check')).toBe(false);
    expect(h.shown('publish')).toBe(false);
    expect(h.shown('cancel')).toBe(true);
    expect(h.timers.pending).toHaveLength(1);

    const summary = FakePublishClient.summary({ dryRun: true });
    h.client.advance({ status: 'uploading', summary, progress: { sent: 550, total: 1100 } });
    await h.timers.fire();
    expect(h.$('session')!.dataset.status).toBe('uploading');
    expect(words(h.$('progress-text'))).toBe('Uploading 550 B of 1.1 kB (50%)');
    expect(h.shown('cancel')).toBe(false);
    expect(words(h.$('footer-note'))).toBe("Closing this window doesn't stop the upload.");

    h.client.advance({ status: 'verifying', progress: null });
    await h.timers.fire();
    expect(words(h.$('wait'))).toBe('The hub is checking the archive…');

    h.client.advance({ status: 'done', result: FakePublishClient.result({ dryRun: true }) });
    await h.timers.fire();
    expect(h.$('session')!.dataset.status).toBe('done');
    expect(words(h.$('result')))
      .toBe('Dry run: http://localhost:8787 accepts @acme/kit@0.1.0 · sha256-abc · it would be a draft you finish in your browser. Nothing was stored.');
    expect(h.$('summary')).not.toBeNull();
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(h.timers.pending).toHaveLength(0);
    // Back on Check / Publish for the real thing; the status wasn't re-read (nothing changed on the hub).
    expect(h.shown('check')).toBe(true);
    expect(h.shown('publish')).toBe(true);
    expect(h.client.status).toHaveBeenCalledTimes(1);
  });
});

describe('Publish: the summary, the upload and the result', () => {
  it('the summary card reads as the CLI prints it, and waits for Upload', async () => {
    const h = await mount();
    await toSummary(h, FakePublishClient.summary({
      contents: {
        features: [{ id: 'a', exportName: 'a', module: 'features/a.feature.js' }, { id: 'b', exportName: 'b', module: 'features/b.feature.js' }],
        parts: [{ exportName: 'part1', name: 'part1', module: 'parts/part1.part.js', params: 0 }],
        assemblies: [],
        models: 1,
        docs: ['docs/index.md'],
      },
      warnings: [{ code: 'docs-link', file: 'docs/index.md', message: 'docs/index.md links to ./missing.md, which is not in the package.' }],
    }));
    expect(h.$('session')!.dataset.status).toBe('awaiting-confirm');
    expect(h.$('summary-title')!.textContent).toBe('Publishing @acme/kit 0.1.0 on http://localhost:8787 as @acme:');
    const rows = [...h.overlay.querySelectorAll<HTMLElement>('[data-ref="summary-row"]')].map((el) => [el.dataset.folder, el.textContent]);
    expect(rows).toEqual([['features/', '2 features'], ['parts/', '1 part'], ['assemblies/', '0 assemblies'], ['docs/', '1 page']]);
    expect(words(h.$('summary-size'))).toBe('5 files, 1.1 kB');
    expect(words(h.$('summary-integrity'))).toBe('integrity: sha256-abc');
    expect(h.$('summary-notes')).toBeNull();
    expect(words(h.$('becomes'))).toBe('first version: you finish publishing in your browser (screenshots, license, release notes)');
    expect(words(h.$('warnings-lead'))).toBe('1 warning (nothing is refused for them):');
    expect(words(h.$('warning'))).toBe('! docs/index.md links to ./missing.md, which is not in the package.');
    expect(words(h.$('confirm-by'))).toMatch(/^Nothing is sent until you upload\. This waits until \d/);
    expect(h.shown('upload')).toBe(true);
    expect(h.shown('cancel')).toBe(true);
    expect(h.shown('publish')).toBe(false);
    // Still polled while it waits (another page, or the timeout, may end it).
    expect(h.timers.pending).toHaveLength(1);
  });

  it('a docs-less package has no docs row; a replaced draft says so', async () => {
    const h = await mount();
    await toSummary(h, FakePublishClient.summary({ replacesDraft: true }));
    expect([...h.overlay.querySelectorAll<HTMLElement>('[data-ref="summary-row"]')].map((el) => el.dataset.folder)).toEqual(['features/', 'parts/', 'assemblies/']);
    expect(words(h.$('becomes'))).toBe('replaces the draft of 0.1.0 on the hub (the wizard keeps what you filled in)');
    expect(h.$('warnings')).toBeNull();
  });

  it('Upload → progress → a first version opens the wizard once, shows its link, and the status is read again', async () => {
    const h = await mount();
    await toSummary(h);
    await h.click('upload');
    expect(h.client.confirm).toHaveBeenCalledTimes(1);
    expect(h.$('session')!.dataset.status).toBe('uploading');
    expect(words(h.$('progress-text'))).toBe('Uploading 0 B of 1.1 kB (0%)');
    expect(h.shown('upload')).toBe(false);
    expect(h.shown('cancel')).toBe(false);
    expect(h.shown('notes')).toBe(false);

    h.client.advance({ progress: { sent: 1100, total: 1100 } });
    await h.timers.fire();
    expect(words(h.$('progress-text'))).toBe('Uploading 1.1 kB of 1.1 kB (100%)');

    h.client.statusValue = FakePublishClient.onHub({ openVersion: FakePublishClient.version() });
    h.client.advance({ status: 'done', progress: null, result: FakePublishClient.result() });
    await h.timers.fire();
    expect(h.$('session')!.dataset.status).toBe('done');
    expect(words(h.$('result-text'))).toBe('Uploaded @acme/kit@0.1.0 · sha256-abc · finish publishing in your browser:');
    expect(h.$('wizard-link')!.textContent).toBe(`${HUB}/publish/@acme/kit/0.1.0`);
    expect(h.openExternal).toHaveBeenCalledTimes(1);
    expect(h.openExternal).toHaveBeenCalledWith(`${HUB}/publish/@acme/kit/0.1.0`);
    // The after-state: the hub's own status, with Open the wizard and Withdraw.
    expect(h.client.status).toHaveBeenCalledTimes(2);
    expect(words(h.$('open-draft'))).toBe('@acme/kit@0.1.0 is a draft · finish publishing in your browser Open the wizard Withdraw');
    expect(h.timers.pending).toHaveLength(0);

    // Nothing opens it again: not a re-render, not a reopen.
    await h.click('open-wizard');
    expect(h.openExternal).toHaveBeenCalledTimes(2);
    h.dialog.hide();
    h.dialog.show();
    await settle();
    expect(h.openExternal).toHaveBeenCalledTimes(2);
    expect(h.$('session')!.dataset.status).toBe('done');
    // The link itself leaves through the host too.
    await h.click('wizard-link');
    expect(h.openExternal).toHaveBeenCalledTimes(3);
  });

  it('a later version is submitted for review, with its status page; a replaced draft is said', async () => {
    const h = await mount((client) => {
      client.statusValue = FakePublishClient.onHub({}, FakePublishClient.version({ status: 'published' }));
    });
    await toSummary(h, FakePublishClient.summary({ version: '0.1.1', becomes: 'in_review' }));
    await h.click('upload');
    h.client.advance({
      status: 'done',
      progress: null,
      result: FakePublishClient.result({ version: '0.1.1', status: 'in_review', wizardUrl: null, reviewUrl: `${HUB}/@acme/kit/status`, replaced: true }),
    });
    await h.timers.fire();
    expect(words(h.$('result-text'))).toBe('Submitted @acme/kit@0.1.1 for review · sha256-abc');
    expect(words(h.$('replaced'))).toBe('Replaced the draft of @acme/kit@0.1.1; the wizard keeps what you filled in.');
    expect(h.$('review-link')!.textContent).toBe(`${HUB}/@acme/kit/status`);
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(h.shown('notes')).toBe(false);
  });

  it('Cancel while it waits: declined, nothing uploaded, back on Publish', async () => {
    const h = await mount();
    await toSummary(h);
    await h.click('cancel');
    expect(h.client.cancel).toHaveBeenCalledTimes(1);
    expect(h.$('session')!.dataset.status).toBe('declined');
    expect(words(h.$('declined'))).toBe('Publish cancelled. Nothing was uploaded.');
    expect(h.shown('publish')).toBe(true);
    expect(h.shown('upload')).toBe(false);
    expect(h.timers.pending).toHaveLength(0);
  });

  it('the engine declining on its own (nobody confirmed in time) is shown', async () => {
    const h = await mount();
    await toSummary(h);
    h.client.advance({ status: 'declined', confirmBy: null, error: { code: 'confirm-timeout', message: "Nothing was uploaded: the upload wasn't confirmed within 10 minutes." } });
    await h.timers.fire();
    expect(words(h.$('declined'))).toBe("Nothing was uploaded: the upload wasn't confirmed within 10 minutes.");
    expect(h.shown('publish')).toBe(true);
  });

  it('the buttons wait while a call is in flight', async () => {
    const h = await mount();
    let release = () => {};
    h.client.startGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.$<HTMLButtonElement>('publish')!.click();
    await settle();
    expect(h.$<HTMLButtonElement>('publish')!.disabled).toBe(true);
    expect(h.$<HTMLButtonElement>('check')!.disabled).toBe(true);
    expect(h.overlay.querySelector<HTMLButtonElement>('[data-bump="patch"]')!.disabled).toBe(true);
    release();
    await settle();
    expect(h.$('session')!.dataset.status).toBe('packing');
    expect(h.$<HTMLButtonElement>('cancel')!.disabled).toBe(false);
  });

  it('closing stops following; reopening picks a waiting session up', async () => {
    const h = await mount();
    await toSummary(h);
    h.dialog.hide();
    expect(h.timers.pending).toHaveLength(0);
    h.dialog.show();
    await settle();
    expect(h.$('session')!.dataset.status).toBe('awaiting-confirm');
    expect(h.shown('upload')).toBe(true);
    expect(h.timers.pending).toHaveLength(1);
  });

  it('a session another page started is followed rather than refused', async () => {
    const h = await mount();
    h.client.session = FakePublishClient.state({ id: 'theirs', status: 'awaiting-confirm', summary: FakePublishClient.summary() });
    h.client.startRefusal = { ok: false, status: 409, error: 'A publish is already running (awaiting-confirm).', code: 'publish-running', details: { id: 'theirs', status: 'awaiting-confirm' } };
    await h.click('publish');
    expect(h.$('session')!.dataset.status).toBe('awaiting-confirm');
    expect(h.shown('upload')).toBe(true);
    expect(h.$('notice')!.classList.contains('hidden')).toBe(true);
  });
});

describe('a refusal before the pack, with its action', () => {
  async function failed(error: { message: string; code: string; details?: unknown }, setup: (client: FakePublishClient) => void = () => {}) {
    const h = await mount((client) => {
      setup(client);
      client.startOutcome = { status: 'failed', error };
    });
    await h.click('publish');
    expect(h.$('session')!.dataset.status).toBe('failed');
    expect(h.$('failed')!.dataset.code).toBe(error.code);
    expect(h.$('result-text')!.textContent).toBe(error.message);
    // Ended at once: nothing to poll.
    expect(h.timers.pending).toHaveLength(0);
    expect(h.shown('publish')).toBe(true);
    return h;
  }

  it('version-not-greater: Bump to the next patch above the hub\'s highest, which clears the refusal', async () => {
    const h = await failed({
      message: '0.1.0 is not greater than 0.3.2, the highest version of @acme/kit published so far. Bump the version, then publish again.',
      code: 'version-not-greater',
      details: { highest: '0.3.2' },
    });
    expect(h.$('bump-above')!.textContent).toBe('Bump to 0.3.3');
    await h.click('bump-above');
    expect(h.client.bumpVersion).toHaveBeenCalledWith('0.3.3');
    expect(h.$('version')!.textContent).toBe('0.3.3');
    expect(h.$('failed')).toBeNull();
    expect(h.shown('session')).toBe(false);
    expect(h.onVersionChanged).toHaveBeenCalledTimes(1);
  });

  it('version-exists: the same action', async () => {
    const h = await failed({ message: '@acme/kit@0.1.0 is already published, and a published version never changes. Bump the version, then publish again.', code: 'version-exists', details: { highest: '0.1.0' } });
    expect(h.$('bump-above')!.textContent).toBe('Bump to 0.1.1');
  });

  it('open-version-exists: Withdraw, asked first with the version the refusal names', async () => {
    const h = await failed(
      { message: '@acme/kit@0.0.9 is in review on http://localhost:8787. Withdraw it, or finish it on the hub, then publish again.', code: 'open-version-exists', details: { version: '0.0.9', status: 'in_review' } },
      (client) => {
        // The status read before the refusal didn't know about it (another computer uploaded it).
        client.statusValue = FakePublishClient.status();
      },
    );
    await h.click('withdraw');
    expect(words(h.$('withdraw-confirm'))).toMatch(/^@acme\/kit@0\.0\.9 is in review on http:\/\/localhost:8787\. Withdrawing deletes it there; its number is free again\./);
    h.client.statusValue = FakePublishClient.onHub({ openVersion: FakePublishClient.version({ version: '0.0.9', status: 'in_review' }) });
    await h.click('withdraw-go');
    expect(h.client.withdraw).toHaveBeenCalledTimes(1);
    // The refusal is answered: the card goes, the notice says what happened.
    expect(h.$('failed')).toBeNull();
    expect(words(h.$('notice'))).toBe('Withdrew @acme/kit@0.0.9 from http://localhost:8787.');
  });

  it('in-review: Withdraw too, from the status\'s open version', async () => {
    const h = await failed(
      { message: '@acme/kit@0.1.0 is in review on http://localhost:8787. Withdraw it, or finish it on the hub, then publish again.', code: 'in-review' },
      (client) => {
        client.statusValue = FakePublishClient.onHub({ openVersion: FakePublishClient.version({ status: 'in_review' }) });
      },
    );
    expect(h.overlay.querySelector('[data-ref="failed"] [data-ref="withdraw"]')).not.toBeNull();
  });

  it('signed-out (a revoked token): Sign in', async () => {
    const h = await failed({ message: 'http://localhost:8787 refused the token. Sign in again, then publish again.', code: 'signed-out', details: { reason: 'token-refused' } });
    expect(h.overlay.querySelector('[data-ref="failed"] [data-ref="sign-in"]')).not.toBeNull();
    await h.click('sign-in');
    expect(h.signIn).toHaveBeenCalledTimes(1);
    expect(h.dialog.isOpen()).toBe(false);
  });

  it('unsaved-changes: save first', async () => {
    const h = await failed({ message: 'parts/part1.part.js has unsaved changes in the editor. Save it, then pack again.', code: 'unsaved-changes' });
    expect(words(h.$('save-first'))).toBe('Save your files first.');
  });

  it('anything else: the sentence alone', async () => {
    const h = await failed({ message: 'Your @acme account has no verified email yet; verify it on the hub to publish.', code: 'email-unverified' });
    expect(h.$('failed')!.querySelectorAll('button')).toHaveLength(0);
    const unreachable = await failed({ message: 'http://localhost:8787 did not answer.', code: 'hub-unreachable', details: { hub: HUB, cause: 'ECONNREFUSED' } });
    expect(unreachable.$('failed')!.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('PublishText', () => {
  it('bumps x.y.z, and refuses anything else', () => {
    expect(PublishText.bumped('0.1.0', 'patch')).toBe('0.1.1');
    expect(PublishText.bumped('0.1.9', 'minor')).toBe('0.2.0');
    expect(PublishText.bumped('1.2.3', 'major')).toBe('2.0.0');
    expect(PublishText.bumped('1.2.3-beta.1', 'patch')).toBe('1.2.4');
    expect(PublishText.bumped('1.2', 'patch')).toBeNull();
    expect(PublishText.bumped('next', 'patch')).toBeNull();
  });

  it('the Manage page is <hub>/@scope/name/manage', () => {
    expect(PublishText.manageUrl('http://localhost:8787/', '@acme/kit')).toBe('http://localhost:8787/@acme/kit/manage');
  });
});
