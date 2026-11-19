// Finding a CLI on the user's machine and running it briefly (version, login
// state). Never through a shell: arguments go to the program as given.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The names a program `name` may have on disk on this platform. */
export function executableNames(name: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') {
    return [name];
  }
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
}

export function isExecutableFile(file: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) {
      return false;
    }
    if (platform === 'win32') {
      return true;
    }
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `name` on the `PATH` of `env`, or null. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  const pathValue = env.PATH ?? env.Path ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  for (const dir of pathValue.split(separator)) {
    if (dir === '' || !path.isAbsolute(dir)) {
      continue;
    }
    for (const candidate of executableNames(name, platform)) {
      const full = path.join(dir, candidate);
      if (isExecutableFile(full, platform)) {
        return full;
      }
    }
  }
  return null;
}

export type ExecResult = { code: number | null; stdout: string; stderr: string; error?: string };

/** Runs `file args` (no shell) and collects its output; never rejects. */
export function runBriefly(
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        env: options.env,
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        shell: false,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as any).code === 'number' ? (error as any).code : null) : 0;
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ...(error && code === null ? { error: error.message } : {}),
        });
      },
    );
  });
}

/** The first `major.minor.patch` in `text`. */
export function parseVersion(text: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** Negative when `a < b`, 0 when equal, positive when `a > b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}
