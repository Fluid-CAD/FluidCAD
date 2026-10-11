import { vi } from 'vitest';
import type {
  InstalledPackage,
  PackageInspection,
  PackageManifest,
  PackagesClient,
  PackagesOverview,
} from '../../src/api';
import { PackageText } from '../../src/ui/packages/packages-state';

/**
 * A {@link PackagesClient} for the package UI's tests: every call is a
 * `vi.fn` answering a plausible success, and `overview` answers whatever
 * the test put in `fake.overview`.
 */
export class FakePackagesClient implements PackagesClient {
  overviewValue: PackagesOverview | null;

  constructor(overview: PackagesOverview | null = FakePackagesClient.overview()) {
    this.overviewValue = overview;
  }

  overview = vi.fn(async () => this.overviewValue);
  /** As the engine: an `as` whose bare part isn't the archive's (`kit`) is refused; without one it installs as the project's pin, `@acme/kit`. */
  inspect = vi.fn(async (_file: Blob, _target?: 'library' | 'project', as?: string | null): Promise<any> => {
    if (as && PackageText.bareOf(as) !== 'kit') {
      return { ok: false as const, status: 400, code: 'wrong-name', error: `This file is kit, so it can't install as ${as}.` };
    }
    return { ok: true as const, inspection: FakePackagesClient.inspection({ token: 'token-2', installsAs: as ?? '@acme/kit' }) };
  });
  install = vi.fn(async (request: { token: string; target: 'library' | 'project'; replace?: boolean; pin?: boolean; as?: string }) => ({
    ok: true as const,
    outcome: {
      target: request.target, name: '@acme/kit', version: '0.1.0', directory: '/lib/@acme/kit/0.1.0',
      integrity: 'sha256-x', status: 'installed' as const, pin: request.pin || request.target === 'project' ? 'pinned' as const : null,
    },
  }));
  discard = vi.fn(async (_token: string) => {});
  copy = vi.fn(async (_name: string, _version: string, _to: 'library' | 'project') => ({ ok: true as const }));
  remove = vi.fn(async (_name: string, _version: string, _target: 'library' | 'project') => ({ ok: true as const, strandedPin: null }));
  copyLibraryOffer = vi.fn(async () => ({ ok: true as const, copies: [{ name: '@acme/kit', version: '0.1.0', status: 'installed' as const }] }));
  dismissLibraryOffer = vi.fn(async () => {});
  savePreferences = vi.fn(async (patch: Record<string, unknown>) => ({ ok: true as const, prefs: { theme: 'fluidcad-dark', ...patch } as any }));
  inspectedIconUrl = (token: string, featureId: string) => `icon/${token}/${featureId}`;

  static manifest(extra: Partial<PackageManifest> = {}): PackageManifest {
    return {
      name: 'kit',
      version: '0.1.0',
      description: 'Standoffs and spacers',
      engine: '0.0.46',
      minEngine: '0.0.45',
      sdkVersion: 1,
      features: [
        { id: 'standoff', exportName: 'standoff', module: 'standoff.feature.js', meta: { label: 'Standoff', icon: './standoff.svg' } as any },
        { id: 'twist', exportName: 'twist', module: 'twist.feature.js', meta: { label: 'Twist' } as any },
      ],
      parts: [{ exportName: 'spacer', module: 'parts/spacer.part.js', name: 'Spacer', kind: 'part' }],
      files: ['fluidcad.json', 'index.js', 'standoff.feature.js', 'standoff.svg', 'twist.feature.js', 'parts/spacer.part.js'],
      ...extra,
    };
  }

  static inspection(extra: Partial<PackageInspection> = {}): PackageInspection {
    return {
      token: 'token-1',
      manifest: FakePackagesClient.manifest(),
      integrity: 'sha256-x',
      warnings: [{ code: 'sdk-version', message: 'Built against a newer feature SDK (version 2); this engine has version 1.' }],
      bytes: 48_600,
      defaultTarget: 'library',
      installsAs: '@acme/kit',
      ...extra,
    };
  }

  static installed(name: string, version: string, extra: Partial<InstalledPackage> = {}): InstalledPackage {
    return {
      target: 'library', name, version, directory: `/lib/${name}/${version}`,
      manifest: FakePackagesClient.manifest({ name: PackageText.bareOf(name), version }), bytes: 48_600, ...extra,
    };
  }

  static overview(extra: Partial<PackagesOverview> = {}): PackagesOverview {
    return {
      library: { path: '/lib', source: 'default', packages: [FakePackagesClient.installed('@acme/kit', '0.1.0')] },
      project: { path: '/ws/packages', packages: [] },
      pins: [],
      updates: {},
      problems: [],
      defaultTarget: 'library',
      libraryOffer: null,
      ...extra,
    };
  }
}

/** A `.fluidpkg` File for the flow (its bytes never matter to the fake). */
export function packageFile(name = 'acme-kit-0.1.0.fluidpkg'): File {
  return new File([new Uint8Array([80, 75, 3, 4])], name);
}

/** Let the awaited fakes settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}
