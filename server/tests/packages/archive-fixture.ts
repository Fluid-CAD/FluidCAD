import JSZip from 'jszip';
import { PackageName } from '../../src/packages/package-name.ts';

/**
 * `.fluidpkg` archives built in memory, without booting the engine: the
 * installer reads only the manifest and the files, so a hand-made archive
 * in the packer's shape exercises it exactly. `PackageBuilder` itself is
 * covered in `package-builder.test.ts`.
 */
export type ArchiveOptions = {
  /**
   * The package: a public name (`@acme/gears`, whose bare part the manifest
   * holds, as a packed archive does since HD29) or the manifest's name as
   * given (a bare name, or a bad one a refusal test wants). `@acme/kit` by
   * default.
   */
  name?: string;
  version?: string;
  /** The package's files besides `manifest.json`; defaults to an entry and one feature module. */
  files?: Record<string, string | Uint8Array>;
  /** Fields merged over the generated manifest; `null` leaves `manifest.json` out. */
  manifest?: Record<string, unknown> | null;
  /** Raw entries added as given, unlisted in the manifest (hostile paths). */
  raw?: Record<string, string>;
};

export class ArchiveFixture {
  static readonly ENGINE = '0.0.46';
  /** The handle a bare name installs under in these tests (`kit` → `@acme/kit`). */
  static readonly SCOPE = 'acme';

  /** The name the archive's manifest holds: the bare part of a public name, else the name as given. */
  static manifestName(options: ArchiveOptions = {}): string {
    const name = options.name ?? `@${ArchiveFixture.SCOPE}/kit`;
    return PackageName.bareOf(name) ?? name;
  }

  /** The public name the tests install the archive as (`as`): the name given, or `@acme/<bare name>`. */
  static publicName(options: ArchiveOptions = {}): string {
    const name = options.name ?? `@${ArchiveFixture.SCOPE}/kit`;
    return PackageName.isValid(name) ? name : `@${ArchiveFixture.SCOPE}/${name}`;
  }

  static defaultFiles(): Record<string, string> {
    return {
      'index.js': "export { standoff } from './standoff.feature.js';\n",
      'standoff.feature.js': "import { Feature } from 'fluidcad/sdk';\nexport const standoff = () => null;\n",
      'fluidcad.json': '{\n  "unit": "mm"\n}\n',
    };
  }

  static manifest(options: ArchiveOptions = {}): Record<string, unknown> {
    const files = options.files ?? ArchiveFixture.defaultFiles();
    return {
      manifestVersion: 1,
      name: ArchiveFixture.manifestName(options),
      version: options.version ?? '0.1.0',
      description: 'A test kit',
      engine: ArchiveFixture.ENGINE,
      minEngine: ArchiveFixture.ENGINE,
      sdkVersion: 1,
      unit: 'mm',
      fileUnits: {},
      contents: ['features'],
      features: [{ id: 'standoff', exportName: 'standoff', module: 'standoff.feature.js', meta: { label: 'Standoff' } }],
      parts: [],
      files: Object.keys(files).sort(),
      ...(options.manifest ?? {}),
    };
  }

  static async zip(options: ArchiveOptions = {}): Promise<Buffer> {
    const zip = new JSZip();
    const files = options.files ?? ArchiveFixture.defaultFiles();
    const date = new Date('2026-10-09T12:00:00.000Z');
    if (options.manifest !== null) {
      zip.file('manifest.json', JSON.stringify(ArchiveFixture.manifest(options), null, 2) + '\n', { date });
    }
    for (const [rel, contents] of Object.entries(files)) {
      zip.file(rel, contents, { date });
    }
    for (const [rel, contents] of Object.entries(options.raw ?? {})) {
      zip.file(rel, contents, { date });
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
}
