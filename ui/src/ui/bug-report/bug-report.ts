/**
 * What a bug report turns into: the text of a GitHub issue and the link that
 * opens GitHub's new-issue page with it filled in.
 *
 * GitHub's new-issue page takes a title and a body from the link's query and
 * nothing else: no picture and no file can ride on it. So the report's
 * attachments stay on the user's machine (the screenshots on the clipboard,
 * the files in one zip the user saves) and the body carries a line for each,
 * saying where to put it. The body built here is the whole of what the link
 * carries, which is what lets the panel show it before anything is opened.
 */

/** What the user filled in. */
export type BugReportDraft = {
  title: string;
  description: string;
  /** How many screenshots go with the report. */
  screenshots: number;
  /** Workspace-relative paths of the files that go with it. */
  files: string[];
  /** The environment lines, already chosen; empty when the user left them out. */
  environment: string[];
};

/** What {@link BugReportEnvironment.lines} reads. */
export type BugReportEnvironmentSource = {
  /** The running engine's version; null when the engine didn't answer. */
  version: string | null;
  /** The desktop shell's `process.platform`; null in a browser or an editor's webview. */
  desktopPlatform: string | null;
  /** Whether the page is framed by an editor (VS Code's webview). */
  framed: boolean;
  userAgent: string;
};

export class BugReport {
  /** Where issues are filed. */
  static readonly ISSUES_URL = 'https://github.com/Fluid-CAD/FluidCAD/issues/new';

  /** The archive the selected files are saved in, and the name the issue's text asks for. */
  static readonly ARCHIVE_NAME = 'fluidcad-bug-report.zip';

  /** The most screenshots one report takes. */
  static readonly MAX_SCREENSHOTS = 8;

  /**
   * The longest link GitHub is sent. Its servers refuse a request line a
   * little over 8,000 bytes (414), and what a refusal shows is an error
   * page with the report gone, so the panel stops short of it.
   */
  static readonly MAX_URL_LENGTH = 7500;

  /** GitHub's own limit on one attached file. */
  static readonly MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

  /** How many file names the issue's text lists before it counts the rest. */
  private static readonly LISTED_FILES = 12;

  /** The issue's text, exactly as the link carries it. */
  static body(draft: BugReportDraft): string {
    const sections: string[] = [];
    const description = draft.description.trim();
    if (description) {
      sections.push(description);
    }
    if (draft.screenshots === 1) {
      sections.push('### Screenshot\n\n_Paste or drop the screenshot here._');
    } else if (draft.screenshots > 1) {
      sections.push(`### Screenshots\n\n_Paste or drop the ${draft.screenshots} screenshots here._`);
    }
    if (draft.files.length > 0) {
      sections.push(
        `### Files\n\n_Drop \`${BugReport.ARCHIVE_NAME}\` here._ It holds ${BugReport.fileList(draft.files)}.`,
      );
    }
    if (draft.environment.length > 0) {
      sections.push(`### Environment\n\n${draft.environment.map((line) => `- ${line}`).join('\n')}`);
    }
    return sections.join('\n\n');
  }

  /** The link that opens GitHub's new-issue page with the title and the text filled in. */
  static url(draft: BugReportDraft): string {
    const query = new URLSearchParams({ title: draft.title.trim(), body: BugReport.body(draft) });
    return `${BugReport.ISSUES_URL}?${query.toString()}`;
  }

  /** How many characters {@link url} runs past what GitHub takes; 0 when it fits. */
  static overflow(draft: BugReportDraft): number {
    return Math.max(0, BugReport.url(draft).length - BugReport.MAX_URL_LENGTH);
  }

  /**
   * A screenshot's name when it is saved as a file (the clipboard refused
   * it): numbered from 1 when the report has several.
   */
  static screenshotName(index: number, total: number): string {
    return total > 1 ? `fluidcad-bug-report-${index + 1}.png` : 'fluidcad-bug-report.png';
  }

  /** `1.2 kB`, `3.4 MB`: a file's size as the list shows it. */
  static size(bytes: number): string {
    if (bytes < 1000) {
      return `${bytes} B`;
    }
    if (bytes < 1_000_000) {
      return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} kB`;
    }
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }

  /** The first names in code spans, then how many more there are. */
  private static fileList(files: string[]): string {
    const listed = files.slice(0, BugReport.LISTED_FILES).map((file) => `\`${file}\``);
    const rest = files.length - listed.length;
    if (rest > 0) {
      listed.push(`${rest} more`);
    }
    if (listed.length === 1) {
      return listed[0];
    }
    return `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}`;
  }
}

export class BugReportEnvironment {
  /** The lines the Environment section lists: the version, where the page runs, the browser. */
  static lines(source: BugReportEnvironmentSource): string[] {
    const lines = [`FluidCAD ${source.version ?? '(version unknown)'}`];
    if (source.desktopPlatform) {
      lines.push(`Desktop app on ${BugReportEnvironment.platformName(source.desktopPlatform)}`);
    } else {
      lines.push(source.framed ? 'In an editor (VS Code webview)' : 'In a browser');
    }
    if (source.userAgent) {
      lines.push(source.userAgent);
    }
    return lines;
  }

  private static platformName(platform: string): string {
    switch (platform) {
      case 'darwin':
        return 'macOS';
      case 'win32':
        return 'Windows';
      case 'linux':
        return 'Linux';
      default:
        return platform;
    }
  }
}
