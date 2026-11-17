// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownStream, isAllowedImageSource, renderMarkdown } from '../src/ui/chat/markdown-stream';
import { sanitizeColorized } from '../src/ui/chat/code-block';

// The chat's markdown renderer (docs/agent-chat-plan.md §10.2): the model's
// text becomes DOM through createElement and text nodes only. Nothing it
// writes may become markup, script, a javascript: link or a remote image —
// streamed in any chunking, unclosed or not — and the colouriser's HTML is
// allowlisted to spans and Monaco's token classes.

const openLink = vi.fn();

function render(text: string, colorize: ((code: string, lang: string) => Promise<string | null>) | null = null): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  renderMarkdown(root, text, { openLink, colorizer: () => colorize });
  return root;
}

/** Every attribute any element carries, as `tag[attr]`. */
function attributes(root: HTMLElement): string[] {
  return [...root.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => `${el.tagName.toLowerCase()}[${a.name}]`));
}

afterEach(() => {
  openLink.mockReset();
  document.body.innerHTML = '';
});

describe('markdown renderer safety', () => {
  it('renders a script tag as text, never as an element', () => {
    const root = render('Hello <script>alert(1)</script> world\n\n<script>\nalert(2)\n</script>');
    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders raw HTML as text: no img, no handlers, no iframes', () => {
    const root = render('<img src=x onerror="alert(1)"> <b onclick="x()">bold?</b> <iframe src="https://e.example"></iframe>');
    expect(root.querySelector('img, b, iframe')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(attributes(root).filter((a) => a.includes('[on'))).toEqual([]);
  });

  it('keeps no javascript:, data: or other non-web link, and opens http(s) ones through the host', () => {
    const root = render('[bad](javascript:alert(1)) [data](data:text/html,<b>x</b>) [file](file:///etc/passwd) [ok](https://example.com/a?b=1)');
    const anchors = [...root.querySelectorAll('a')];
    expect(anchors).toHaveLength(4);
    expect(anchors.slice(0, 3).every((a) => !a.hasAttribute('href'))).toBe(true);
    const ok = anchors[3];
    expect(ok.getAttribute('href')).toBe('https://example.com/a?b=1');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    ok.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(openLink).toHaveBeenCalledWith('https://example.com/a?b=1');
    // A dead link does nothing when clicked.
    anchors[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openLink).toHaveBeenCalledTimes(1);
  });

  it('links a bare http(s) URL', () => {
    const root = render('See https://fluidcad.io/docs for more.');
    expect(root.querySelector('a')!.getAttribute('href')).toBe('https://fluidcad.io/docs');
  });

  it('loads images only from data:image or the page’s own origin; otherwise shows the alt text', () => {
    const root = render(
      '![remote](https://evil.example/track.png) ![js](javascript:alert(1)) ![inline](data:image/png;base64,iVBORw0KGgo=) ![own](api/agent/sessions/x/files/a.png)',
    );
    const images = [...root.querySelectorAll('img')];
    expect(images.map((img) => img.getAttribute('src'))).toEqual(['data:image/png;base64,iVBORw0KGgo=', 'api/agent/sessions/x/files/a.png']);
    expect(root.textContent).toContain('[remote]');
    expect(root.textContent).toContain('[js]');
    expect(isAllowedImageSource('data:text/html;base64,PHA+', 'http://127.0.0.1:3100/')).toBe(false);
    expect(isAllowedImageSource('//evil.example/x.png', 'http://127.0.0.1:3100/')).toBe(false);
    expect(isAllowedImageSource('/p/abc/api/x.png', 'http://127.0.0.1:3100/p/abc/')).toBe(true);
  });

  it('renders an unclosed fence as it arrives and closes it on end()', () => {
    const root = document.createElement('div');
    const colorize = vi.fn(async () => '<span class="mtk1">x</span>');
    const stream = createMarkdownStream(root, { openLink, colorizer: () => colorize });
    stream.write('Code:\n\n```js\nconst a = 1;\n');
    const code = root.querySelector('pre code')!;
    expect(code.textContent).toMatch(/^const a = 1;\n?$/);
    expect(colorize).not.toHaveBeenCalled();
    stream.write('<script>alert(1)</script>');
    expect(root.querySelector('script')).toBeNull();
    stream.end();
    expect(colorize).toHaveBeenCalledWith('const a = 1;\n<script>alert(1)</script>', 'js');
    expect(code.textContent).toBe('const a = 1;\n<script>alert(1)</script>');
  });

  it('gives the same DOM however the text is chunked', () => {
    const text = '# Title\n\nSome **bold** and *italic* and `code`.\n\n- one\n- [x] two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nlet x: number = 1;\n```\n\nEnd [link](https://example.com).';
    const whole = render(text).innerHTML;
    const root = document.createElement('div');
    const stream = createMarkdownStream(root, { openLink, colorizer: () => null });
    for (const char of text) {
      stream.write(char);
    }
    stream.end();
    expect(root.innerHTML).toBe(whole);
    expect(root.querySelector('strong')!.textContent).toBe('bold');
    expect(root.querySelector('table th')!.textContent!.trim()).toBe('a');
    expect((root.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    expect(root.querySelector('[data-ref="code-block"] code')!.textContent).toBe('let x: number = 1;');
  });

  it('leaves only spans, line breaks and Monaco token classes of the colouriser’s HTML', () => {
    const fragment = sanitizeColorized(
      '<span class="mtk1 evil"><span class="mtk5 mtki">const</span></span><br/><img src=x onerror="alert(1)"><script>bad()</script>'
        + '<a href="javascript:x" class="mtk2">y</a><span style="background:url(x)" onclick="z()">z</span><svg><script>s()</script></svg>',
    );
    const holder = document.createElement('div');
    holder.appendChild(fragment);
    expect(holder.querySelector('img, script, a, svg')).toBeNull();
    expect(attributes(holder).sort()).toEqual(['span[class]', 'span[class]']);
    expect(holder.querySelector('.mtk1')!.className).toBe('mtk1');
    expect(holder.querySelector('.mtk5')!.className).toBe('mtk5 mtki');
    expect(holder.textContent).toBe('constyz');
  });

  it('colours a closed code block through the allowlist, and keeps it plain without a colouriser', async () => {
    const colored = render('```js\nlet a\n```', async () => '<span class="mtk8">let</span><img src=x onerror=alert(1)><span class="mtk1"> a</span>');
    await vi.waitFor(() => expect(colored.querySelector('.mtk8')).not.toBeNull());
    expect(colored.querySelector('img')).toBeNull();
    expect(colored.querySelector('code')!.textContent).toBe('let a');
    const plain = render('```js\nlet a\n```', null);
    expect(plain.querySelector('code')!.children).toHaveLength(0);
    expect(plain.querySelector('code')!.textContent).toBe('let a');
  });
});
