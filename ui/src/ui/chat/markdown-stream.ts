import * as smd from 'streaming-markdown';
import { CodeBlock, type Colorizer } from './code-block';

/**
 * Markdown into DOM as it streams (docs/agent-chat-plan.md §10.2): the
 * answer's text is written chunk by chunk and rendered append-only — what is
 * on screen is never parsed again, and an unclosed fence or emphasis shows
 * as it arrives. Behind this two-method interface so the parser can be
 * swapped without touching the transcript.
 */
export interface MarkdownStream {
  /** Render another chunk. */
  write(text: string): void;
  /** The text is complete: flush what the parser holds, close what is open. */
  end(): void;
}

export type MarkdownOptions = {
  /** Open an http(s) link in the user's browser (ExternalLinks). */
  openLink(url: string): void;
  /** Colours a closed code block; null leaves code plain. Read when each block closes. */
  colorizer?(): Colorizer | null;
};

/**
 * `streaming-markdown` with our own renderer: every node is made with
 * `createElement` and every string goes in as a text node, so nothing the
 * model writes is ever parsed as HTML (the parser itself has no raw-HTML
 * token: `<script>` arrives as text). Links keep only an `http:` or
 * `https:` href and open through {@link MarkdownOptions.openLink}; images
 * load only from `data:image/…` or this page's own origin, and otherwise
 * show their alt text. Code blocks are {@link CodeBlock}s.
 */
export function createMarkdownStream(root: HTMLElement, options: MarkdownOptions): MarkdownStream {
  const renderer = new DomRenderer(root, options);
  const parser = smd.parser({
    data: renderer,
    add_token: (r: DomRenderer, type: smd.Token) => r.open(type),
    end_token: (r: DomRenderer) => r.close(),
    add_text: (r: DomRenderer, text: string) => r.text(text),
    set_attr: (r: DomRenderer, type: smd.Attr, value: string) => r.attr(type, value),
  });
  let ended = false;
  return {
    write(text: string) {
      if (!ended && text !== '') {
        smd.parser_write(parser, text);
      }
    },
    end() {
      if (ended) {
        return;
      }
      ended = true;
      smd.parser_end(parser);
      renderer.closeAll();
    },
  };
}

/** Renders a whole, finished markdown text (a reloaded transcript). */
export function renderMarkdown(root: HTMLElement, text: string, options: MarkdownOptions): void {
  const stream = createMarkdownStream(root, options);
  stream.write(text);
  stream.end();
}

/** Whether `url` may be an image source: a data image, or this page's own origin. */
export function isAllowedImageSource(url: string, base: string = location.href): boolean {
  const trimmed = url.trim();
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(trimmed)) {
    return true;
  }
  try {
    const parsed = new URL(trimmed, base);
    const page = new URL(base);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === page.origin;
  } catch {
    return false;
  }
}

/** Whether `url` may be a link: http(s) only. */
export function isAllowedLink(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

type Frame = {
  type: smd.Token;
  /** Where children and text go. */
  node: HTMLElement;
  code?: CodeBlock;
  image?: { holder: HTMLElement; alt: string };
};

class DomRenderer {
  private readonly stack: Frame[];

  constructor(root: HTMLElement, private readonly options: MarkdownOptions) {
    this.stack = [{ type: smd.DOCUMENT, node: root }];
  }

  private get top(): Frame {
    return this.stack[this.stack.length - 1];
  }

  open(type: smd.Token): void {
    const parent = this.top.node;
    const frame: Frame = { type, node: parent };
    switch (type) {
      case smd.DOCUMENT:
        return;
      case smd.PARAGRAPH:
        frame.node = append(parent, 'p');
        break;
      case smd.HEADING_1:
      case smd.HEADING_2:
      case smd.HEADING_3:
      case smd.HEADING_4:
      case smd.HEADING_5:
      case smd.HEADING_6:
        // Headings in a chat bubble: one size step, not a document's.
        frame.node = append(parent, `h${Math.min(6, smd.heading_to_level(type) + 2)}`);
        break;
      case smd.BLOCKQUOTE:
        frame.node = append(parent, 'blockquote');
        break;
      case smd.LINE_BREAK:
        frame.node = append(parent, 'br');
        break;
      case smd.RULE:
        frame.node = append(parent, 'hr');
        break;
      case smd.ITALIC_AST:
      case smd.ITALIC_UND:
        frame.node = append(parent, 'em');
        break;
      case smd.STRONG_AST:
      case smd.STRONG_UND:
        frame.node = append(parent, 'strong');
        break;
      case smd.STRIKE:
        frame.node = append(parent, 's');
        break;
      case smd.CODE_INLINE:
      case smd.EQUATION_INLINE:
        frame.node = append(parent, 'code');
        break;
      case smd.LINK:
      case smd.RAW_URL: {
        // An anchor without an href until a safe one arrives: plain text otherwise.
        frame.node = append(parent, 'a');
        break;
      }
      case smd.IMAGE: {
        const holder = append(parent, 'span');
        holder.className = 'chat-md-image';
        frame.node = holder;
        frame.image = { holder, alt: '' };
        break;
      }
      case smd.LIST_UNORDERED:
        frame.node = append(parent, 'ul');
        break;
      case smd.LIST_ORDERED:
        frame.node = append(parent, 'ol');
        break;
      case smd.LIST_ITEM:
        frame.node = append(parent, 'li');
        break;
      case smd.CHECKBOX: {
        const box = append(parent, 'input') as HTMLInputElement;
        box.type = 'checkbox';
        box.disabled = true;
        box.className = 'checkbox checkbox-xs align-middle mr-1';
        frame.node = box;
        break;
      }
      case smd.CODE_BLOCK:
      case smd.CODE_FENCE:
      case smd.EQUATION_BLOCK: {
        const block = new CodeBlock(() => (type === smd.EQUATION_BLOCK ? null : (this.options.colorizer?.() ?? null)));
        parent.appendChild(block.el);
        frame.code = block;
        frame.node = block.el;
        break;
      }
      case smd.TABLE: {
        const scroller = append(parent, 'div');
        scroller.className = 'chat-md-table';
        frame.node = append(scroller, 'table');
        break;
      }
      case smd.TABLE_ROW: {
        // The first row is the header; the rest go to one body.
        let section: HTMLElement;
        const sections = parent.children;
        if (sections.length === 0) {
          section = append(parent, 'thead');
        } else if (sections.length === 1) {
          section = append(parent, 'tbody');
        } else {
          section = sections[1] as HTMLElement;
        }
        frame.node = append(section, 'tr');
        break;
      }
      case smd.TABLE_CELL:
        frame.node = append(parent, parent.parentElement?.tagName === 'THEAD' ? 'th' : 'td');
        break;
      default:
        frame.node = append(parent, 'span');
        break;
    }
    this.stack.push(frame);
  }

  close(): void {
    if (this.stack.length <= 1) {
      return;
    }
    const frame = this.stack.pop()!;
    frame.code?.finish();
    if (frame.image) {
      // No usable source arrived: the alt text stands, marked as an image.
      if (!frame.image.holder.querySelector('img')) {
        frame.image.holder.textContent = frame.image.alt ? `[${frame.image.alt}]` : '';
      }
    }
  }

  closeAll(): void {
    while (this.stack.length > 1) {
      this.close();
    }
  }

  text(text: string): void {
    const frame = this.top;
    if (frame.code) {
      frame.code.append(text);
      return;
    }
    if (frame.image) {
      frame.image.alt += text;
      return;
    }
    if (frame.node instanceof HTMLInputElement || frame.node instanceof HTMLBRElement || frame.node instanceof HTMLHRElement) {
      return;
    }
    frame.node.appendChild(document.createTextNode(text));
  }

  attr(type: smd.Attr, value: string): void {
    const frame = this.top;
    switch (type) {
      case smd.HREF: {
        const anchor = frame.node;
        if (!(anchor instanceof HTMLAnchorElement)) {
          return;
        }
        const url = value.trim();
        if (!isAllowedLink(url)) {
          anchor.classList.add('chat-md-dead-link');
          anchor.title = url;
          return;
        }
        anchor.href = url;
        anchor.title = url;
        anchor.rel = 'noopener noreferrer';
        anchor.target = '_blank';
        anchor.addEventListener('click', (event) => {
          event.preventDefault();
          this.options.openLink(url);
        });
        return;
      }
      case smd.SRC: {
        if (!frame.image) {
          return;
        }
        if (isAllowedImageSource(value)) {
          const img = document.createElement('img');
          img.src = value.trim();
          img.alt = frame.image.alt;
          img.loading = 'lazy';
          frame.image.holder.replaceChildren(img);
        }
        return;
      }
      case smd.LANG:
        frame.code?.setLanguage(value);
        return;
      case smd.CHECKED:
        if (frame.node instanceof HTMLInputElement) {
          frame.node.checked = true;
        }
        return;
      case smd.START: {
        const start = Number.parseInt(value, 10);
        if (frame.node instanceof HTMLOListElement && Number.isFinite(start)) {
          frame.node.start = start;
        }
        return;
      }
    }
  }
}

function append(parent: HTMLElement, tag: string): HTMLElement {
  return parent.appendChild(document.createElement(tag));
}
