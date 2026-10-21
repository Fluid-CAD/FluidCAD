import { escapeHtml } from './param-row';

/** A part body as the render names it: its hidden identity (`ParamDefinition.body`) and its name. */
export type PartBodyRef = { body: string; name: string };

/**
 * How the UI names a part body. A body's identity is hidden — the part's
 * export binding (`export const lid = part('Plate', …)` → `lid`), else its
 * name and order (`Plate#2`) — and the part is shown by its NAME. Only when
 * another body of the file has the same name does the identity's tag follow
 * it, dimmed: `Plate (lid)`, `Plate (#2)`. Mirrors lib `PartIdentity`.
 */
export class PartLabels {
  /** The class of the dimmed tag after a shared name. */
  static readonly TAG_CLASS = 'font-normal text-base-content/50';

  /** body → its name. */
  private readonly names = new Map<string, string>();
  /** name → the bodies of that name. */
  private readonly bodiesByName = new Map<string, string[]>();

  constructor(bodies: Iterable<PartBodyRef>) {
    for (const { body, name } of bodies) {
      if (this.names.has(body)) {
        continue;
      }
      this.names.set(body, name);
      const same = this.bodiesByName.get(name) ?? [];
      same.push(body);
      this.bodiesByName.set(name, same);
    }
  }

  /** The bodies a render's parameters name — `bodyName` beside each `body`. */
  static fromParams(params: Iterable<{ body?: string; bodyName?: string }>): PartLabels {
    const bodies: PartBodyRef[] = [];
    for (const param of params) {
      if (param.body !== undefined) {
        bodies.push({ body: param.body, name: param.bodyName ?? param.body });
      }
    }
    return new PartLabels(bodies);
  }

  /** What tells a body apart from another of its name: its binding, or `#n` for a `Name#n` identity. */
  static tagOf(body: string): string {
    const fallback = /#\d+$/.exec(body);
    return fallback ? fallback[0] : body;
  }

  /** The body's name — the identity itself for a body this list does not know. */
  name(body: string): string {
    return this.names.get(body) ?? body;
  }

  /** Whether another body of the list has this body's name. */
  isShared(body: string): boolean {
    return (this.bodiesByName.get(this.name(body))?.length ?? 0) > 1;
  }

  /** The bodies named `name`. */
  bodiesNamed(name: string): string[] {
    return (this.bodiesByName.get(name) ?? []).slice();
  }

  /** The tag shown after a shared name, null for a name only this body has. */
  tag(body: string): string | null {
    return this.isShared(body) ? PartLabels.tagOf(body) : null;
  }

  /** The body as plain text: `Plate`, or `Plate (lid)` when the name is shared. */
  label(body: string): string {
    const tag = this.tag(body);
    return tag === null ? this.name(body) : `${this.name(body)} (${tag})`;
  }

  /** The body as HTML: the name, and a shared name's tag dimmed after it. */
  html(body: string): string {
    const tag = this.tag(body);
    const name = escapeHtml(this.name(body));
    return tag === null ? name : `${name} <span class="${PartLabels.TAG_CLASS}" data-part-tag>(${escapeHtml(tag)})</span>`;
  }
}
