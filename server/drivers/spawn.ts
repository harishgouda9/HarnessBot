import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Every CLI launch in the harness goes through here.
 *
 * Hard rule: no `shell: true`, ever, and no building a command string. Model output
 * reaches these argv arrays, and a shell would turn a tool argument into arbitrary
 * code execution on the user's seat.
 */

const isWindows = process.platform === 'win32';
const execFileAsync = promisify(execFile);

/** Where CLIs actually land. A GUI app inherits a thin PATH, so guessing is required. */
function searchDirs(): string[] {
  const home = os.homedir();
  const extra = (process.env.HB_EXTRA_PATH ?? '').split(path.delimiter).filter(Boolean);
  const fromEnv = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const common = isWindows
    ? [
        path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs'),
        path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'),
        path.join(home, '.bun', 'bin'),
        path.join(home, '.local', 'bin'),
      ]
    : [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        path.join(home, '.local', 'bin'),
        path.join(home, '.bun', 'bin'),
        path.join(home, '.deno', 'bin'),
        path.join(home, '.volta', 'bin'),
        path.join(home, '.nvm', 'versions', 'node'),
        path.join(home, 'go', 'bin'),
        path.join(home, '.cargo', 'bin'),
      ];
  return [...extra, ...fromEnv, ...common];
}

const EXECUTABLE_EXTS = isWindows ? ['.cmd', '.exe', '.bat', '.ps1', ''] : [''];

/** Resolve a CLI name to an absolute path, or null when it is not installed. */
export function findCli(name: string): string | null {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  for (const dir of searchDirs()) {
    for (const ext of EXECUTABLE_EXTS) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Missing dir or permission denied: just keep looking.
      }
    }
  }
  return null;
}

interface LaunchPlan {
  file: string;
  args: string[];
}

/**
 * Decide what to actually exec.
 *
 * - `.mjs` / `.js` (our scripted fake CLIs): run through this Node, because Windows
 *   does not honour shebangs (HB-TRD-001 consideration 14).
 * - `.cmd` / `.bat` (npm shims): Node refuses to spawn these without a shell, so they
 *   go through cmd.exe — still as an argv array, never as a concatenated string.
 */
function plan(command: string, args: string[]): LaunchPlan {
  const ext = path.extname(command).toLowerCase();
  if (ext === '.mjs' || ext === '.js' || ext === '.cjs') {
    return { file: process.execPath, args: [command, ...args] };
  }
  if (isWindows && (ext === '.cmd' || ext === '.bat')) {
    return { file: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] };
  }
  if (isWindows && ext === '.ps1') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', command, ...args],
    };
  }
  return { file: command, args };
}

export interface CliSpawnOptions {
  cwd?: string;
  /** Replaces the environment wholesale — no ambient credential inheritance. */
  env?: Record<string, string | undefined>;
}

export function spawnCli(command: string, args: string[], opts: CliSpawnOptions = {}): ChildProcessWithoutNullStreams {
  const { file, args: finalArgs } = plan(command, args);
  const options: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  };
  return spawn(file, finalArgs, options) as ChildProcessWithoutNullStreams;
}

export async function execCli(
  command: string,
  args: string[],
  opts: CliSpawnOptions & { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { file, args: finalArgs } = plan(command, args);
  return execFileAsync(file, finalArgs, {
    cwd: opts.cwd,
    env: opts.env as NodeJS.ProcessEnv,
    timeout: opts.timeoutMs ?? 10_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
}

/**
 * Kill the whole process tree. A CLI that spawns its own children leaves zombies
 * otherwise, and a zombie agent still holds the model session (NFR-REL-3).
 */
export function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, shell: false });
      return;
    } catch {
      // taskkill missing: fall through to the portable path.
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, 2000);
  timer.unref?.();
}

/** Split a byte stream into whole lines. Vendors chunk JSON mid-line all the time. */
export function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
  };
}
