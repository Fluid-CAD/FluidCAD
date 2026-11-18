// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from '../src/ui/chat/chat-panel';
import type { ChatMessage } from '../src/ui/chat/chat-types';
import { fitImageSize, ImageAttachments, MAX_ATTACHMENTS, sniffImageType, type ImagePreparer } from '../src/ui/chat/image-attachments';
import { LeftSlot } from '../src/ui/left-slot';
import { FakeChatClient } from './fixtures/fake-chat-client';
import { settle } from './fixtures/fake-packages-client';

// Images attached to a chat message: picked with the composer's Attach
// button, pasted into the message box or dropped on the panel; shown as
// thumbnails above the box until the message is sent, and in the message
// after. Sizing an image needs the browser's decoder and a canvas, which
// jsdom has not: the tests hand the panel a preparer of their own.

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
const revoked: string[] = [];
let urls = 0;

beforeAll(() => {
  // jsdom has no object URLs.
  URL.createObjectURL = () => `blob:test/${++urls}`;
  URL.revokeObjectURL = (url: string) => void revoked.push(url);
});

afterAll(() => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

const panels: ChatPanel[] = [];

afterEach(() => {
  for (const panel of panels.splice(0)) {
    panel.destroy();
  }
  revoked.length = 0;
  document.body.innerHTML = '';
});

const file = (name: string, type = 'image/png', body = name) => new File([body], name, { type });
const base64 = (text: string) => btoa(text);

/** Sends every image as it is, as a PNG; a file named `broken…` cannot be read; `slow…` waits for {@link release}. */
function fakePreparer() {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const prepare: ImagePreparer = async (blob) => {
    const name = (blob as File).name;
    if (name.startsWith('broken')) {
      throw new Error('not an image');
    }
    if (name.startsWith('slow')) {
      await held;
    }
    return { blob, mediaType: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png' };
  };
  return { prepare, release };
}

function mount(client = new FakeChatClient()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const preparer = fakePreparer();
  const panel = new ChatPanel({
    container,
    client,
    slot: new LeftSlot({ width: 500 }),
    settings: () => ({ defaultAgent: null, permissionMode: 'ask' }),
    openExternal: () => {},
    prepareImage: preparer.prepare,
  });
  panels.push(panel);
  const $ = <T extends Element = HTMLElement>(selector: string) => panel.el.querySelector<T>(selector);
  const $$ = <T extends Element = HTMLElement>(selector: string) => [...panel.el.querySelectorAll<T>(selector)];
  const input = () => $<HTMLTextAreaElement>('[data-ref="input"]')!;
  const sendButton = () => $<HTMLButtonElement>('[data-ref="send"]')!;
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input'));
  };
  const enter = () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  /** The thumbnails as "name(state)". */
  const thumbs = () => $$('[data-ref="image-thumb"]').map((t) => `${t.title}(${t.dataset.state})`);
  const notice = () => {
    const el = $('[data-ref="image-notice"]')!;
    return el.classList.contains('hidden') ? '' : el.textContent;
  };
  /** Pick `files` in the dialog behind the Attach button. */
  const pickFiles = (files: File[]) => {
    const picker = $<HTMLInputElement>('[data-ref="attach-input"]')!;
    Object.defineProperty(picker, 'files', { value: files, configurable: true });
    picker.dispatchEvent(new Event('change'));
  };
  const paste = (files: File[], text = '') => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => text } });
    input().dispatchEvent(event);
    return event;
  };
  const drag = (kind: 'dragover' | 'dragleave' | 'drop', files: File[], types = ['Files'], target: Element = panel.el) => {
    const event = new Event(kind, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types, files, dropEffect: 'none' } });
    target.dispatchEvent(event);
    return event as Event & { dataTransfer: { dropEffect: string } };
  };
  return { client, panel, container, release: preparer.release, $, $$, input, sendButton, type, enter, thumbs, notice, pickFiles, paste, drag };
}

async function opened(h: ReturnType<typeof mount>): Promise<void> {
  h.panel.show();
  await settle();
  await settle();
}

describe('an image file, before it is sent', () => {
  it('is known by its first bytes, whatever it is called', () => {
    const bytes = (...values: (number | string)[]) => new Uint8Array(values.flatMap((v) => (typeof v === 'string' ? [...v].map((c) => c.charCodeAt(0)) : [v])));
    expect(sniffImageType(bytes(0x89, 'PNG\r\n', 0x1a, '\n', 'IHDR'))).toBe('image/png');
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 'JFIF'))).toBe('image/jpeg');
    expect(sniffImageType(bytes('GIF89a', 1, 0, 1, 0))).toBe('image/gif');
    expect(sniffImageType(bytes('RIFF', 4, 0, 0, 0, 'WEBP'))).toBe('image/webp');
    expect(sniffImageType(bytes('<svg xmlns='))).toBeNull();
    expect(sniffImageType(bytes('BM', 0, 0))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });

  it('keeps its size up to 2000 px on its longest edge, and is scaled to it beyond', () => {
    expect(fitImageSize(1600, 900)).toEqual({ width: 1600, height: 900 });
    expect(fitImageSize(2000, 2000)).toEqual({ width: 2000, height: 2000 });
    expect(fitImageSize(4000, 3000)).toEqual({ width: 2000, height: 1500 });
    expect(fitImageSize(1000, 8000)).toEqual({ width: 250, height: 2000 });
    expect(fitImageSize(30000, 3)).toEqual({ width: 2000, height: 1 });
  });
});

describe('the images above the message box', () => {
  it('lists what was added, leaves out what is not an image and what is over the limit, and says so', async () => {
    const changes: number[] = [];
    const images: ImageAttachments = new ImageAttachments({ prepare: fakePreparer().prepare, onChange: () => changes.push(images.size) });
    document.body.append(images.el);
    const names = () => [...images.el.querySelectorAll<HTMLElement>('[data-ref="image-thumb"]')].map((t) => t.title);
    const notice = () => images.el.querySelector('[data-ref="image-notice"]')!.textContent;
    expect(images.el.classList.contains('hidden')).toBe(true);

    images.add([file('front.png'), file('notes.txt', 'text/plain'), file('side.jpg', 'image/jpeg')]);
    expect(names()).toEqual(['front.png', 'side.jpg']);
    expect(notice()).toBe('Only images can be attached.');
    expect(images.el.classList.contains('hidden')).toBe(false);

    // Up to the limit; the rest is left out. A good add clears the line.
    images.add(Array.from({ length: MAX_ATTACHMENTS }, (_, i) => file(`more-${i}.png`)));
    expect(images.size).toBe(MAX_ATTACHMENTS);
    expect(notice()).toBe(`A message takes at most ${MAX_ATTACHMENTS} images.`);
    images.el.querySelector<HTMLElement>('[data-ref="remove-image"]')!.click();
    expect(names()[0]).toBe('side.jpg');
    expect(notice()).toBe('');
    expect(revoked).toHaveLength(1);
    expect(changes.at(-1)).toBe(MAX_ATTACHMENTS - 1);

    // What a message carries: each image's bytes, type and name, in order.
    const sent = await images.forSend();
    expect(sent.attachments.slice(0, 2)).toEqual([
      { mediaType: 'image/jpeg', base64: base64('side.jpg'), name: 'side.jpg' },
      { mediaType: 'image/png', base64: base64('more-0.png'), name: 'more-0.png' },
    ]);
    // Sent: they leave, and their thumbnails' URLs are let go; one added since stays.
    images.add([file('late.png')]);
    images.clearSent(sent.ids);
    expect(names()).toEqual(['late.png']);
    expect(revoked).toHaveLength(MAX_ATTACHMENTS);
    images.destroy();
    expect(revoked).toHaveLength(MAX_ATTACHMENTS + 1);
  });

  it('drops an image that cannot be read and says which; one still being sized is waited for', async () => {
    const preparer = fakePreparer();
    const images = new ImageAttachments({ prepare: preparer.prepare });
    document.body.append(images.el);
    const thumbs = () => [...images.el.querySelectorAll<HTMLElement>('[data-ref="image-thumb"]')].map((t) => `${t.title}(${t.dataset.state})`);
    images.add([file('broken.heic', 'image/heic'), file('slow.png'), file('ok.png')]);
    expect(thumbs()).toEqual(['broken.heic(preparing)', 'slow.png(preparing)', 'ok.png(preparing)']);
    await settle();
    expect(thumbs()).toEqual(['slow.png(preparing)', 'ok.png(ready)']);
    expect(images.el.querySelector('[data-ref="image-notice"]')!.textContent).toBe('broken.heic could not be read as an image.');

    let sent: Awaited<ReturnType<ImageAttachments['forSend']>> | null = null;
    void images.forSend().then((s) => (sent = s));
    await settle();
    expect(sent).toBeNull();
    preparer.release();
    await settle();
    expect(sent!.attachments.map((a) => a.name)).toEqual(['slow.png', 'ok.png']);
    images.destroy();
  });
});

describe('attaching an image in the Agent panel', () => {
  it('the Attach button picks images; they go with the message, and the strip empties once it is taken', async () => {
    const h = mount();
    await opened(h);
    const attach = h.$<HTMLButtonElement>('[data-ref="attach"]')!;
    expect(attach.getAttribute('aria-label')).toBe('Attach an image');
    const picker = h.$<HTMLInputElement>('[data-ref="attach-input"]')!;
    expect(picker.accept).toBe('image/png,image/jpeg,image/webp,image/gif');
    expect(picker.multiple).toBe(true);
    const clicked = vi.fn();
    picker.addEventListener('click', clicked);
    attach.click();
    expect(clicked).toHaveBeenCalledTimes(1);

    h.pickFiles([file('bracket.png'), file('photo.jpg', 'image/jpeg')]);
    await settle();
    expect(h.thumbs()).toEqual(['bracket.png(ready)', 'photo.jpg(ready)']);
    h.type('Model this bracket');
    h.enter();
    await settle();
    expect(h.client.sent[0].message).toEqual({
      text: 'Model this bracket',
      model: 'default',
      mode: 'ask',
      attachments: [
        { mediaType: 'image/png', base64: base64('bracket.png'), name: 'bracket.png' },
        { mediaType: 'image/jpeg', base64: base64('photo.jpg'), name: 'photo.jpg' },
      ],
    });
    expect(h.thumbs()).toEqual([]);
    expect(h.input().value).toBe('');
  });

  it('an image goes without words: Send is on with one attached, off again when it is removed', async () => {
    const h = mount();
    await opened(h);
    expect(h.sendButton().disabled).toBe(true);
    h.pickFiles([file('drawing.png')]);
    await settle();
    expect(h.sendButton().disabled).toBe(false);
    h.$<HTMLElement>('[data-ref="remove-image"]')!.click();
    expect(h.sendButton().disabled).toBe(true);
    h.enter();
    await settle();
    expect(h.client.sent).toEqual([]);

    h.pickFiles([file('drawing.png')]);
    h.enter();
    await settle();
    expect(h.client.sent[0].message).toMatchObject({ text: '', attachments: [{ name: 'drawing.png' }] });
    expect(h.thumbs()).toEqual([]);
  });

  it('a pasted image is attached; a clipboard that also has text is pasted as text', async () => {
    const h = mount();
    await opened(h);
    const shot = h.paste([file('image.png')]);
    expect(shot.defaultPrevented).toBe(true);
    await settle();
    expect(h.thumbs()).toEqual(['image.png(ready)']);

    // A spreadsheet's cells come with a picture of themselves: the text is what is pasted.
    const cells = h.paste([file('cells.png')], 'A1\tB1');
    expect(cells.defaultPrevented).toBe(false);
    // Text alone is the browser's own paste.
    expect(h.paste([], 'hello').defaultPrevented).toBe(false);
    await settle();
    expect(h.thumbs()).toEqual(['image.png(ready)']);
  });

  it('a file dropped anywhere on the panel is attached, and never left to the browser', async () => {
    const h = mount();
    await opened(h);
    const transcript = h.panel.transcript.el;
    const over = h.drag('dragover', [], ['Files'], transcript);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('copy');
    expect(h.panel.el.hasAttribute('data-dropping')).toBe(true);
    h.drag('dragleave', []);
    expect(h.panel.el.hasAttribute('data-dropping')).toBe(false);

    h.drag('dragover', [], ['Files'], transcript);
    const drop = h.drag('drop', [file('scan.png'), file('notes.pdf', 'application/pdf')], ['Files'], transcript);
    expect(drop.defaultPrevented).toBe(true);
    expect(h.panel.el.hasAttribute('data-dropping')).toBe(false);
    await settle();
    expect(h.thumbs()).toEqual(['scan.png(ready)']);
    expect(h.notice()).toBe('Only images can be attached.');

    // Dragged text is none of the panel's business.
    expect(h.drag('dragover', [], ['text/plain']).defaultPrevented).toBe(false);
    expect(h.drag('drop', [], ['text/plain']).defaultPrevented).toBe(false);
  });

  it('with no agent ready, a dropped file is neither attached nor opened by the browser', async () => {
    const client = new FakeChatClient();
    client.agentsValue = [FakeChatClient.install({ path: null, version: null, supported: false, loggedIn: null, authMethod: null, problem: 'Claude Code was not found.' })];
    const h = mount(client);
    await opened(h);
    const over = h.drag('dragover', []);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('none');
    expect(h.panel.el.hasAttribute('data-dropping')).toBe(false);
    expect(h.drag('drop', [file('scan.png')]).defaultPrevented).toBe(true);
    await settle();
    expect(h.thumbs()).toEqual([]);
  });

  it('a send the engine refuses keeps the images', async () => {
    const h = mount();
    await opened(h);
    h.client.send.mockResolvedValueOnce({ ok: false, status: 400, error: 'Each of `attachments` must be an image.' });
    h.pickFiles([file('drawing.png')]);
    h.type('model this');
    h.enter();
    await settle();
    expect(h.thumbs()).toEqual(['drawing.png(ready)']);
    expect(h.input().value).toBe('model this');
  });

  it('on the API agent, says so when the model picked takes no images', async () => {
    const noProgram = FakeChatClient.install({ path: null, version: null, supported: false, loggedIn: null, authMethod: null });
    const client = new FakeChatClient();
    client.agentsValue = [noProgram, FakeChatClient.apiInstall([FakeChatClient.provider({ id: 'openrouter', hasKey: true, keySource: 'stored', ready: true })])];
    client.apiModelsValue = [
      { id: 'openrouter/vision', label: 'Vision', provider: 'openrouter', isDefault: true, acceptsImages: true },
      { id: 'openrouter/text-only', label: 'Text only', provider: 'openrouter', acceptsImages: false },
    ];
    const h = mount(client);
    await opened(h);
    h.pickFiles([file('a.png'), file('b.png')]);
    await settle();
    expect(h.notice()).toBe('');
    const pick = (label: string) => {
      h.$<HTMLElement>('[data-ref="composer-controls"] [data-ref="model-picker"]')!.click();
      const menu = h.container.querySelector('[data-ref="model-menu"]')!;
      [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((r) => r.textContent!.trim() === label)!.click();
    };
    pick('Text only');
    expect(h.notice()).toBe('This model does not take images: they will be left out.');
    h.$<HTMLElement>('[data-ref="remove-image"]')!.click();
    expect(h.notice()).toBe('This model does not take images: it will be left out.');
    pick('Vision');
    expect(h.notice()).toBe('');
  });

  it('on a local server with Send images off, says so for whatever model is typed', async () => {
    const noProgram = FakeChatClient.install({ path: null, version: null, supported: false, loggedIn: null, authMethod: null });
    const client = new FakeChatClient();
    client.agentsValue = [noProgram, FakeChatClient.apiInstall([FakeChatClient.provider({ id: 'ollama', label: 'Ollama', baseURL: 'http://localhost:11434/v1' })])];
    const h = mount(client);
    await opened(h);
    h.pickFiles([file('a.png')]);
    await settle();
    expect(h.notice()).toBe('This model does not take images: it will be left out.');
  });

  it('Claude Code is sent the images whatever its model list says', async () => {
    const client = new FakeChatClient();
    client.modelsValue = [{ id: 'default', label: 'Default', isDefault: true, acceptsImages: false }];
    const h = mount(client);
    await opened(h);
    h.pickFiles([file('a.png')]);
    await settle();
    expect(h.notice()).toBe('');
  });
});

describe('a message with images, in the transcript', () => {
  it('shows the attached images in one row by their names, apart from the references capture; a click shows one in full', async () => {
    const client = new FakeChatClient();
    const message: ChatMessage = {
      id: 'user-1',
      role: 'user',
      turnId: 'turn-1',
      createdAt: '2026-11-18T10:00:00.000Z',
      parts: [
        { type: 'text', id: 't', text: 'Model this' },
        { type: 'image', id: 'i1', file: 'a.jpg', name: 'front view.jpg' },
        { type: 'image', id: 'i2', file: 'b.png', name: 'image' },
        { type: 'image', id: 'i3', file: 'capture.png' },
      ],
    };
    const session = client.addSession({ messages: [message] });
    const h = mount(client);
    await opened(h);
    const row = h.$('[data-role="user"] [data-ref="attached-images"]')!;
    const attached = [...row.querySelectorAll('img')];
    expect(attached.map((img) => [img.alt, img.getAttribute('src')])).toEqual([
      ['front view.jpg', client.fileUrl(session.id, 'a.jpg')],
      ['image', client.fileUrl(session.id, 'b.png')],
    ]);
    const capture = h.$$<HTMLImageElement>('[data-role="user"] [data-part="image"][data-kind="capture"] img');
    expect(capture.map((img) => img.alt)).toEqual(['The attached capture']);
    expect(capture[0].closest('[data-ref="attached-images"]')).toBeNull();

    const first = attached[0].parentElement!;
    attached[0].click();
    expect(first.classList.contains('chat-image-full')).toBe(true);
    attached[0].click();
    expect(first.classList.contains('chat-image-full')).toBe(false);
    // The capture is shown as it is.
    capture[0].click();
    expect(capture[0].parentElement!.classList.contains('chat-image-full')).toBe(false);
  });
});
