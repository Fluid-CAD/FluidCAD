/**
 * The name a new package workspace is given on the start screen, checked
 * before it is sent to the launcher: `@handle/name`, the grammar the engine
 * requires of a package (K11, HD30). The launcher holds the same pattern in
 * `launcher/src/projects/project-package.ts` — the badge's reader — and
 * `launcher/tests/start-contract.test.ts` keeps the two identical; the page
 * cannot import the launcher's (it reads files), so this is its copy, as
 * `host.ts` is for the contract's types.
 *
 * The start screen takes the whole name (U5): it has no hub client to ask a
 * handle of, so the hint says what the part before the slash is.
 */
export class PackageName {
  /** Each part lowercase letters, digits and single dashes, starting with a letter; the handle 2–39 characters, the name at most 64. */
  static readonly PATTERN = /^@(?=[a-z0-9-]{2,39}\/)[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/(?=[a-z0-9-]{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

  static readonly PLACEHOLDER = '@handle/name';

  /** Under the field: what the two parts are. */
  static readonly HINT = 'The part before the slash is your hub handle; the part after it names the package.';

  /** The one sentence a name that does not fit gets. */
  static readonly PROBLEM =
    'A package name is @handle/name: lowercase letters, digits and single dashes, each part starting with a letter.';

  static isValid(name: string): boolean {
    return PackageName.PATTERN.test(name);
  }

  /** Why `name` cannot be a package name, or null when it can. An empty name is simply not there yet: no sentence. */
  static problem(name: string): string | null {
    const trimmed = name.trim();
    if (trimmed === '' || PackageName.isValid(trimmed)) {
      return null;
    }
    return PackageName.PROBLEM;
  }

  /** The folder a package is given by default: the part after the slash (`@acme/kit` → `kit`); empty while there is none. */
  static folderNameOf(name: string): string {
    const slash = name.indexOf('/');
    return slash === -1 ? '' : name.slice(slash + 1).trim();
  }
}
