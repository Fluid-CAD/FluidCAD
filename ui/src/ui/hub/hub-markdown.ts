/**
 * A package's README as a safe Markdown subset (hub-plan H11, decision 8):
 * headings, paragraphs, lists, block quotes, code blocks and inline code,
 * bold and italic, rules, pipe tables and links. Built with DOM nodes and
 * `textContent` only, so nothing in the file becomes markup: raw HTML shows
 * as the text it is, images are not loaded (their alt text stands in), and
 * a link opens in the user's browser through `openLink` (only `http(s)`;
 * anything else stays plain text).
 */
export class HubMarkdown {
  /** The longest README rendered; the rest is cut with a note (the hub keeps README.md at 512 KB). */
  static readonly MAX_CHARS = 200_000;

  private constructor(private readonly openLink: (url: string) => void) {}

  static render(text: string, openLink: (url: string) => void): HTMLDivElement {
    const root = document.createElement('div');
    root.dataset.role = 'readme';
    root.className = 'flex flex-col gap-3 text-hub-sm leading-relaxed text-base-content/85 min-w-0 break-words';
    const source = text.length > HubMarkdown.MAX_CHARS ? text.slice(0, HubMarkdown.MAX_CHARS) : text;
    new HubMarkdown(openLink).blocks(source.replace(/\r\n?/g, '\n').split('\n'), root);
    if (text.length > HubMarkdown.MAX_CHARS) {
      const cut = document.createElement('p');
      cut.className = 'text-hub-xs text-base-content/50';
      cut.textContent = 'The rest of the README is on the hub.';
      root.appendChild(cut);
    }
    return root;
  }

  // ---------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------

  private blocks(lines: string[], into: HTMLElement): void {
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') {
        i++;
        continue;
      }
      const fence = /^\s*(```|~~~)(.*)$/.exec(line);
      if (fence) {
        const code: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) {
          code.push(lines[i]);
          i++;
        }
        i++;
        into.appendChild(HubMarkdown.codeBlock(code.join('\n')));
        continue;
      }
      const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        into.appendChild(this.heading(heading[1].length, heading[2]));
        i++;
        continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        const rule = document.createElement('hr');
        rule.className = 'border-base-content/10';
        into.appendChild(rule);
        i++;
        continue;
      }
      if (/^\s{0,3}>/.test(line)) {
        const quoted: string[] = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i++;
        }
        const quote = document.createElement('blockquote');
        quote.className = 'border-l-2 border-base-content/20 pl-3 text-base-content/70 flex flex-col gap-2';
        this.blocks(quoted, quote);
        into.appendChild(quote);
        continue;
      }
      if (HubMarkdown.isTableStart(lines, i)) {
        const rows: string[] = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          rows.push(lines[i]);
          i++;
        }
        into.appendChild(this.table(rows));
        continue;
      }
      const item = HubMarkdown.listItem(line);
      if (item) {
        const list = document.createElement(item.ordered ? 'ol' : 'ul');
        list.className = `${item.ordered ? 'list-decimal' : 'list-disc'} pl-5 flex flex-col gap-1`;
        while (i < lines.length) {
          const next = HubMarkdown.listItem(lines[i]);
          if (next && next.ordered === item.ordered) {
            const li = document.createElement('li');
            const text = [next.text];
            i++;
            // Continuation lines (indented, not a new item) belong to this item.
            while (i < lines.length && lines[i].trim() !== '' && /^\s{2,}/.test(lines[i]) && !HubMarkdown.listItem(lines[i])) {
              text.push(lines[i].trim());
              i++;
            }
            this.inline(text.join(' '), li);
            list.appendChild(li);
            continue;
          }
          if (next && HubMarkdown.indent(lines[i]) >= 2) {
            // A nested item reads as one more item of this list.
            const li = document.createElement('li');
            this.inline(next.text, li);
            list.appendChild(li);
            i++;
            continue;
          }
          break;
        }
        into.appendChild(list);
        continue;
      }
      const paragraph: string[] = [];
      while (i < lines.length && lines[i].trim() !== '' && !HubMarkdown.startsBlock(lines, i)) {
        paragraph.push(lines[i].trim());
        i++;
      }
      if (paragraph.length === 0) {
        paragraph.push(line.trim());
        i++;
      }
      const p = document.createElement('p');
      this.inline(paragraph.join(' '), p);
      into.appendChild(p);
    }
  }

  private heading(level: number, text: string): HTMLElement {
    const el = document.createElement(`h${Math.min(level + 2, 6)}`);
    el.className = level <= 1 ? 'text-hub-lg font-medium text-base-content/90 mt-1' : 'text-hub-md font-medium text-base-content/90';
    this.inline(text, el);
    return el;
  }

  private table(rows: string[]): HTMLElement {
    const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    const wrap = document.createElement('div');
    wrap.className = 'overflow-x-auto';
    const table = document.createElement('table');
    table.className = 'w-full text-hub-xs border border-base-content/10 rounded';
    const head = document.createElement('thead');
    head.className = 'bg-base-200 text-base-content/55';
    const headRow = document.createElement('tr');
    for (const cell of cells(rows[0])) {
      const th = document.createElement('th');
      th.className = 'text-left font-normal px-2 py-1';
      this.inline(cell, th);
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    const body = document.createElement('tbody');
    body.className = 'divide-y divide-base-content/[0.07]';
    for (const row of rows.slice(2)) {
      const tr = document.createElement('tr');
      for (const cell of cells(row)) {
        const td = document.createElement('td');
        td.className = 'px-2 py-1 align-top';
        this.inline(cell, td);
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    table.append(head, body);
    wrap.appendChild(table);
    return wrap;
  }

  private static codeBlock(code: string): HTMLPreElement {
    const pre = document.createElement('pre');
    pre.className = 'font-mono text-hub-xs leading-relaxed bg-base-200 rounded-md px-3 py-2 overflow-x-auto whitespace-pre';
    const el = document.createElement('code');
    el.textContent = code;
    pre.appendChild(el);
    return pre;
  }

  private static isTableStart(lines: string[], i: number): boolean {
    return lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1]);
  }

  private static listItem(line: string): { ordered: boolean; text: string } | null {
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      return { ordered: false, text: bullet[1] };
    }
    const numbered = /^\s*\d{1,9}[.)]\s+(.*)$/.exec(line);
    return numbered ? { ordered: true, text: numbered[1] } : null;
  }

  private static indent(line: string): number {
    return /^\s*/.exec(line)![0].length;
  }

  private static startsBlock(lines: string[], i: number): boolean {
    const line = lines[i];
    return /^\s*(```|~~~)/.test(line) || /^\s{0,3}#{1,6}\s/.test(line) || /^\s{0,3}>/.test(line)
      || HubMarkdown.listItem(line) !== null || HubMarkdown.isTableStart(lines, i);
  }

  // ---------------------------------------------------------------------------
  // Inline: code, links, images (as their alt text), bold, italic
  // ---------------------------------------------------------------------------

  private static readonly INLINE = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\([^)]*\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/;

  private inline(text: string, into: HTMLElement): void {
    let rest = text;
    while (rest.length > 0) {
      const match = HubMarkdown.INLINE.exec(rest);
      if (!match) {
        into.append(rest);
        return;
      }
      if (match.index > 0) {
        into.append(rest.slice(0, match.index));
      }
      into.appendChild(this.token(match));
      rest = rest.slice(match.index + match[0].length);
    }
  }

  private token(match: RegExpExecArray): Node {
    if (match[1] !== undefined) {
      const code = document.createElement('code');
      code.className = 'font-mono text-hub-xs px-1 rounded bg-base-200';
      code.textContent = match[2];
      return code;
    }
    if (match[3] !== undefined) {
      const alt = document.createElement('span');
      alt.className = 'text-base-content/50 italic';
      alt.textContent = match[3] ? `[image: ${match[3]}]` : '[image]';
      return alt;
    }
    if (match[4] !== undefined) {
      return this.link(match[4], match[5]);
    }
    if (match[6] !== undefined) {
      return this.link(match[6], match[6]);
    }
    const strong = match[7] ?? match[8];
    if (strong !== undefined) {
      const el = document.createElement('strong');
      el.className = 'font-medium';
      this.inline(strong, el);
      return el;
    }
    const em = document.createElement('em');
    this.inline(match[9] ?? match[10] ?? '', em);
    return em;
  }

  private link(text: string, url: string): Node {
    if (!/^https?:\/\//i.test(url)) {
      return document.createTextNode(text);
    }
    const link = document.createElement('a');
    link.href = url;
    link.className = 'link link-primary';
    link.title = url;
    link.rel = 'noopener noreferrer';
    link.textContent = text;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      this.openLink(url);
    });
    return link;
  }
}
