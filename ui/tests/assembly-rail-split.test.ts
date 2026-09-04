// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PartsPanel } from '../src/ui/parts-panel';
import { ConnectorsPanel } from '../src/ui/connectors-panel';
import { JointsPanel } from '../src/ui/joints-panel';
import { railSplit } from '../src/ui/assembly-rail-split';

// The assembly rail's column splits by who is open: Parts holds half of it
// beside anything else, the other open sections share the rest equally, a
// closed section drops to its header and hands its room back, and a section
// open on its own has the whole column. The split is re-applied from the
// sections' own change events, so Connectors and Joints — built by the
// caller against the Parts panel's slots — need no wiring to take part.

type Rail = {
  hosts: { parts: HTMLElement; connectors: HTMLElement; joints: HTMLElement };
  header: (title: string) => HTMLElement;
};

function mount(options: { connectors?: boolean } = {}): Rail {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const parts = new PartsPanel(container, () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
  if (options.connectors !== false) {
    new ConnectorsPanel(parts.getConnectorsHost(), {
      onEdit: () => {},
      onToggleVisibility: () => {},
      isHidden: () => false,
    });
  }
  new JointsPanel(parts.getJointsHost(), () => {}, () => {}, () => {}, () => {}, () => {});
  const connectors = parts.getConnectorsHost();
  const hosts = {
    parts: connectors.previousElementSibling as HTMLElement,
    connectors,
    joints: parts.getJointsHost(),
  };
  const headers = () => [...container.querySelectorAll<HTMLElement>('.panel-bg.cursor-pointer')];
  return {
    hosts,
    header: (title) => headers().find((h) => h.textContent?.includes(title))!,
  };
}

/** The flex-basis class on a host, or 'closed' when it has no claim on the column. */
function share(host: HTMLElement): string {
  const classes = host.className.split(/\s+/);
  if (classes.includes('grow-0')) {
    expect(classes).toContain('shrink-0');
    expect(classes).toContain('basis-auto');
    return 'closed';
  }
  expect(classes).toContain('grow');
  expect(classes).toContain('shrink');
  return classes.find((c) => c.startsWith('basis-'))!;
}

function shares(rail: Rail): Record<string, string> {
  return {
    parts: share(rail.hosts.parts),
    connectors: share(rail.hosts.connectors),
    joints: share(rail.hosts.joints),
  };
}

describe('assembly rail split policy', () => {
  it('halves the column for Parts and quarters the rest with everything open', () => {
    const split = railSplit({ parts: true, connectors: true, joints: true });
    expect(split.parts).toContain('basis-1/2');
    expect(split.connectors).toContain('basis-1/4');
    expect(split.joints).toContain('basis-1/4');
  });

  it('keeps Parts at half beside one other open section, which takes the other half', () => {
    const noConnectors = railSplit({ parts: true, connectors: false, joints: true });
    expect(noConnectors.parts).toContain('basis-1/2');
    expect(noConnectors.joints).toContain('basis-1/2');
    const noJoints = railSplit({ parts: true, connectors: true, joints: false });
    expect(noJoints.parts).toContain('basis-1/2');
    expect(noJoints.connectors).toContain('basis-1/2');
  });

  it('splits the column between Connectors and Joints once Parts closes', () => {
    const split = railSplit({ parts: false, connectors: true, joints: true });
    expect(split.connectors).toContain('basis-1/2');
    expect(split.joints).toContain('basis-1/2');
  });

  it('gives a lone open section the whole column', () => {
    expect(railSplit({ parts: false, connectors: false, joints: true }).joints).toContain('basis-full');
    expect(railSplit({ parts: false, connectors: true, joints: false }).connectors).toContain('basis-full');
    expect(railSplit({ parts: true, connectors: false, joints: false }).parts).toContain('basis-full');
  });

  it('caps every host at its own rows so a short section hands its room on', () => {
    const split = railSplit({ parts: true, connectors: true, joints: true });
    for (const host of Object.values(split)) {
      expect(host).toContain('max-h-max');
      expect(host).toContain('min-h-0');
    }
  });

  it('drops a closed section to its header, with no claim on the column', () => {
    const split = railSplit({ parts: false, connectors: false, joints: true });
    for (const host of [split.parts, split.connectors]) {
      expect(host).toContain('grow-0');
      expect(host).toContain('shrink-0');
      expect(host).toContain('basis-auto');
      expect(host).not.toMatch(/\bbasis-(full|1\/2|1\/4)\b/);
    }
  });
});

describe('assembly rail column', () => {
  it('stacks Parts, Connectors and Joints and opens all three', () => {
    const rail = mount();
    expect(rail.hosts.parts.nextElementSibling).toBe(rail.hosts.connectors);
    expect(rail.hosts.connectors.nextElementSibling).toBe(rail.hosts.joints);
    expect(shares(rail)).toEqual({ parts: 'basis-1/2', connectors: 'basis-1/4', joints: 'basis-1/4' });
  });

  it('follows the headers through every combination', () => {
    const rail = mount();

    rail.header('Connectors').click();
    expect(shares(rail)).toEqual({ parts: 'basis-1/2', connectors: 'closed', joints: 'basis-1/2' });

    rail.header('Parts').click();
    expect(shares(rail)).toEqual({ parts: 'closed', connectors: 'closed', joints: 'basis-full' });

    rail.header('Connectors').click();
    expect(shares(rail)).toEqual({ parts: 'closed', connectors: 'basis-1/2', joints: 'basis-1/2' });

    rail.header('Joints').click();
    expect(shares(rail)).toEqual({ parts: 'closed', connectors: 'basis-full', joints: 'closed' });

    rail.header('Parts').click();
    expect(shares(rail)).toEqual({ parts: 'basis-1/2', connectors: 'basis-1/2', joints: 'closed' });

    rail.header('Connectors').click();
    expect(shares(rail)).toEqual({ parts: 'basis-full', connectors: 'closed', joints: 'closed' });

    rail.header('Joints').click();
    expect(shares(rail)).toEqual({ parts: 'basis-1/2', connectors: 'closed', joints: 'basis-1/2' });
  });

  it('treats a slot nothing mounted in as closed', () => {
    // The browser viewer builds Parts + Joints only.
    const rail = mount({ connectors: false });
    expect(shares(rail)).toEqual({ parts: 'basis-1/2', connectors: 'closed', joints: 'basis-1/2' });
    rail.header('Parts').click();
    expect(shares(rail)).toEqual({ parts: 'closed', connectors: 'closed', joints: 'basis-full' });
  });

  it('keeps every slot the positioning context for its section\'s row menus', () => {
    // The joints panel's ⋮ / context menu is appended to its host and placed
    // from the host's rect; a re-split used to rewrite the host's classes
    // and drop the `relative` the panel had added, so the menu resolved
    // against the column and opened over Parts.
    const rail = mount();
    for (const host of Object.values(rail.hosts)) {
      expect(host.classList.contains('relative')).toBe(true);
    }
    rail.header('Parts').click();
    rail.header('Connectors').click();
    for (const host of Object.values(rail.hosts)) {
      expect(host.classList.contains('relative')).toBe(true);
    }
  });

  it('keeps each section body scrolling inside its host', () => {
    const rail = mount();
    for (const title of ['Parts', 'Connectors', 'Joints']) {
      const body = rail.header(title).nextElementSibling as HTMLElement;
      expect(body.className).toContain('flex-1');
      expect(body.className).toContain('min-h-0');
      expect(body.className).toContain('overflow-y-auto');
    }
  });
});
