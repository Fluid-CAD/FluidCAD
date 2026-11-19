import iconCopy from '@tabler/icons/outline/copy.svg?raw';
import iconCheck from '@tabler/icons/outline/check.svg?raw';
import { DANGEROUS_TAGS, sanitizeHtml, type HtmlPolicy } from '../../helpers/sanitize-html';

/**
 * Colours `code` in `language` as HTML (Monaco's `editor.colorize`, through
 * the loaded editor); null when it cannot (no editor chunk, an unknown
 * language). The HTML is untrusted as far as this module is concerned.
 */
export type Colorizer = (code: string, language: string) => Promise<string | null>;

/**
 * What survives of the colouriser's HTML: its line spans, the `<br>`s
 * between lines, and Monaco's token classes (`mtk<n>` colours, `mtki`
 * italic, `mtkb` bold, `mtku` underline, `mtks` strikethrough), which the
 * editor's theme styles. Every other class and attribute goes.
 */
const COLORIZED_POLICY: HtmlPolicy = {
  keep: new Set(['SPAN', 'BR']),
  drop: DANGEROUS_TAGS,
  attribute: (_el, name, value) => {
    if (name !== 'class') {
      return null;
    }
    const kept = value.split(/\s+/).filter((c) => /^mtk(\d+|[ibus])$/.test(c));
    return kept.length > 0 ? kept.join(' ') : null;
  },
};

/** The colouriser's HTML, allowlisted (exported for tests). */
export function sanitizeColorized(html: string): DocumentFragment {
  return sanitizeHtml(html, COLORIZED_POLICY);
}

/**
 * A fenced or indented code block in an answer: the language, a copy button
 * and the code. It fills as the answer streams, as plain text; once the
 * fence closes ({@link finish}) the code is coloured like the editor's, when
 * the editor is loaded, and stays plain otherwise.
 */
export class CodeBlock {
  readonly el: HTMLDivElement;
  private readonly code: HTMLElement;
  private readonly label: HTMLSpanElement;
  private readonly copyBtn: HTMLButtonElement;
  private language = '';
  private source = '';
  private finished = false;

  /** `colorizer` is asked when the fence closes: the editor may have loaded since the block began. */
  constructor(private readonly colorizer: () => Colorizer | null) {
    this.el = document.createElement('div');
    this.el.className = 'chat-code';
    this.el.dataset.ref = 'code-block';
    const bar = document.createElement('div');
    bar.className = 'chat-code-bar';
    this.label = document.createElement('span');
    this.label.className = 'chat-code-lang';
    this.copyBtn = document.createElement('button');
    this.copyBtn.type = 'button';
    this.copyBtn.dataset.ref = 'copy';
    this.copyBtn.className = 'btn btn-ghost btn-xs btn-square text-base-content/60 [&>svg]:size-3.5';
    this.copyBtn.title = 'Copy';
    this.copyBtn.setAttribute('aria-label', 'Copy the code');
    this.copyBtn.innerHTML = iconCopy;
    this.copyBtn.addEventListener('click', () => void this.copy());
    bar.append(this.label, this.copyBtn);
    const pre = document.createElement('pre');
    this.code = document.createElement('code');
    pre.appendChild(this.code);
    this.el.append(bar, pre);
  }

  /** The code as written (without the fence's last newline). */
  get text(): string {
    return this.source.replace(/\n$/, '');
  }

  setLanguage(language: string): void {
    this.language = language.trim().split(/\s+/)[0] ?? '';
    this.label.textContent = this.language;
    this.code.dataset.lang = this.language;
  }

  append(text: string): void {
    this.source += text;
    this.code.appendChild(document.createTextNode(text));
  }

  /** The fence closed: colour it once, if a colouriser is there and knows the language. */
  finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const text = this.text;
    if (text !== this.source) {
      this.code.textContent = text;
    }
    const colorize = this.colorizer();
    if (!colorize || !this.language || text === '') {
      return;
    }
    colorize(text, this.language)
      .then((html) => {
        if (html) {
          const fragment = sanitizeColorized(html);
          this.code.replaceChildren(fragment);
          this.code.classList.add('chat-code-colorized');
        }
      })
      .catch(() => undefined);
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.text);
    } catch {
      return;
    }
    this.copyBtn.innerHTML = iconCheck;
    this.copyBtn.title = 'Copied';
    setTimeout(() => {
      this.copyBtn.innerHTML = iconCopy;
      this.copyBtn.title = 'Copy';
    }, 1200);
  }
}
