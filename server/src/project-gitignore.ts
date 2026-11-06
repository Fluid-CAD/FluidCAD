import fs from 'fs';
import path from 'path';
import ignoreFactory, { type Ignore } from 'ignore';
import { INSTANCE_DIR_NAME } from './instance-file.ts';

/** What {@link ProjectGitignore.ensure} did. */
export type ProjectGitignoreChange = 'created' | 'added' | 'present';

/**
 * The project's `.gitignore` as `fluidcad init` leaves it (the user,
 * 2026-10-12): `.fluidcad/` ignored. That folder holds this machine's state
 * for the project (the running engine's `instance.json`, the editor's tabs
 * in `editor-state.json`, the panels' choices in `ui-state.json`), never
 * the project's content, so it stays out of git.
 *
 * - No `.gitignore`: one is written holding `.fluidcad/` alone.
 * - A `.gitignore` that already ignores the folder, however it says so
 *   (`.fluidcad`, `/.fluidcad/`, `.*`…), or that keeps it on purpose with a
 *   negation (`!.fluidcad/`): left exactly as it is.
 * - Any other: `.fluidcad/` is appended on a line of its own (after a
 *   newline when the file doesn't end with one). Nothing else in the file
 *   changes, and running it again adds nothing.
 */
export class ProjectGitignore {
  /** The `ignore` package's factory, typed as the repo's other matchers type it (its CJS default export). */
  private static readonly matcher = ignoreFactory as unknown as () => Ignore;

  static readonly FILENAME = '.gitignore';
  /** The line written: the folder at any depth git sees it, as git users write it. */
  static readonly ENTRY = `${INSTANCE_DIR_NAME}/`;

  static ensure(projectDir: string): ProjectGitignoreChange {
    const file = path.join(projectDir, ProjectGitignore.FILENAME);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      fs.writeFileSync(file, `${ProjectGitignore.ENTRY}\n`);
      return 'created';
    }
    if (ProjectGitignore.covers(text)) {
      return 'present';
    }
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(file, `${separator}${ProjectGitignore.ENTRY}\n`);
    return 'added';
  }

  /** Whether `text` already ignores `.fluidcad/`, or deliberately keeps it (a negation naming it). */
  static covers(text: string): boolean {
    if (ProjectGitignore.matcher().add(text).ignores(`${ProjectGitignore.ENTRY}instance.json`)) {
      return true;
    }
    return text.split(/\r?\n/).some((line) => ProjectGitignore.keepsFolder(line.trim()));
  }

  /** `!.fluidcad`, `!/.fluidcad/`, `!**\/.fluidcad/…`: the author un-ignored it on purpose. */
  private static keepsFolder(line: string): boolean {
    if (!line.startsWith('!')) {
      return false;
    }
    const pattern = line.slice(1).replace(/^\/+/, '').replace(/^\*\*\//, '');
    return pattern === INSTANCE_DIR_NAME || pattern.startsWith(`${INSTANCE_DIR_NAME}/`);
  }
}
