import type { FeatureLayoutItem, FeatureLayoutSection, FeatureMetaSnapshot } from '../../src/api';

/** A hand-built snapshot: everything but the layout, which {@link DerivedLayout.snapshot} fills in. */
export type BareFeatureMeta = Omit<FeatureMetaSnapshot, 'layout'> & { layout?: FeatureLayoutItem[] };

/**
 * The layout the engine derives for a feature that declares none
 * (`FeatureLayouts.derive` in `lib/sdk/layout.ts`), for snapshots a test
 * writes by hand: values in declaration order, a section per `group` where
 * it first appears, and one `tabs` item — a pane per `tab` — after the rows
 * above it.
 */
export class DerivedLayout {
  static of(params: FeatureMetaSnapshot['params']): FeatureLayoutItem[] {
    const top: FeatureLayoutItem[] = [];
    const tabs = new Map<string, FeatureLayoutItem[]>();
    for (const [name, spec] of Object.entries(params)) {
      let items = top;
      if (spec.tab) {
        items = tabs.get(spec.tab) ?? [];
        tabs.set(spec.tab, items);
      }
      if (!spec.group) {
        items.push(name);
        continue;
      }
      const section = items.find((each): each is FeatureLayoutSection =>
        typeof each !== 'string' && 'section' in each && each.section === spec.group);
      if (section) {
        section.items.push(name);
      } else {
        items.push({ section: spec.group, items: [name] });
      }
    }
    if (tabs.size > 0) {
      top.push({ tabs: [...tabs].map(([label, items]) => ({ label, items })) } as FeatureLayoutItem);
    }
    return top;
  }

  /** The snapshot the engine would send: the one given, its layout derived unless it carries one. */
  static snapshot(meta: BareFeatureMeta): FeatureMetaSnapshot {
    return { ...meta, layout: meta.layout ?? DerivedLayout.of(meta.params) };
  }
}
