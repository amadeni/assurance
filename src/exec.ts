// Ausgeführte Prüfungen: die CLI startet das Projekt, statt nur Dateien zu
// lesen. Der Runner ist injizierbar, damit die Prüfung ohne echtes
// Dev-Backend testbar bleibt; `spawnRunner` ist der echte.

import { spawn } from 'node:child_process';

import type { Check } from './checks.js';
import { allDependencies } from './repo.js';

export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<CommandResult>;

export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;

export const spawnRunner: CommandRunner = (command, args, options) =>
  new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, CI: process.env.CI ?? '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', chunk => (stdout += String(chunk)));
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
      // Fortschritt live nach stderr — im CI-Log sieht man, welcher Schritt hängt.
      process.stderr.write(String(chunk));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({
        code: null,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });

/** Die letzte stdout-Zeile als JSON (Muster dev-contract), sonst null. */
export function lastJsonLine(stdout: string): unknown {
  const lines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

/** Der letzte `[step]`-Befund aus stderr — die Diagnose von dev-contract. */
export function lastStepLine(stderr: string): string | null {
  const lines = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^\[[a-z-]+\]/.test(line));
  return lines[lines.length - 1] ?? null;
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

type StartOutput = {
  ok?: unknown;
  auth?: { email?: unknown; cookies?: unknown };
};

// `login-verified`: `dev-contract start` muss ready melden — und ready
// heißt dort „Login verifiziert“, mit ausgestellten Cookies. Danach wird
// die Umgebung in jedem Fall gestoppt.
export const loginVerified: Check = async (repo, ctx) => {
  if (!ctx.exec) {
    return {
      status: 'skipped',
      detail:
        'nicht ausgeführt (--no-exec) — der Start wird nur im CI-Lauf geprüft.',
    };
  }
  const deps = allDependencies(repo.packageJson());
  if (!deps['@amadeni/dev-contract'])
    return {
      status: 'fail',
      detail: '@amadeni/dev-contract ist keine Abhängigkeit.',
    };
  if (!repo.exists('devcontract.config.json'))
    return { status: 'fail', detail: 'devcontract.config.json fehlt.' };
  const start = await ctx.run('pnpm', ['exec', 'dev-contract', 'start'], {
    cwd: repo.root,
    timeoutMs: ctx.execTimeoutMs,
  });
  try {
    await ctx.run('pnpm', ['exec', 'dev-contract', 'stop'], {
      cwd: repo.root,
      timeoutMs: 60_000,
    });
  } catch {
    // Der Nachweis hängt am Start; ein hängender Stop ist ein CI-Aufräumproblem.
  }
  const step = lastStepLine(start.stderr);
  const because = step ? ` — ${step}` : '';
  if (start.timedOut)
    return {
      status: 'fail',
      detail: `dev-contract start hat nach ${seconds(start.durationMs)} nicht ready gemeldet${because}.`,
    };
  const output = lastJsonLine(start.stdout) as StartOutput | null;
  if (start.code !== 0 || !output || output.ok !== true)
    return {
      status: 'fail',
      detail: `dev-contract start ist nicht ready geworden (Exit ${start.code ?? '?'})${because}.`,
    };
  const cookies = output.auth?.cookies;
  const cookieCount =
    cookies && typeof cookies === 'object' ? Object.keys(cookies).length : 0;
  if (cookieCount === 0)
    return {
      status: 'fail',
      detail:
        'dev-contract start meldet ready ohne verifizierte Sitzung (keine Cookies).',
    };
  const email =
    typeof output.auth?.email === 'string' ? output.auth.email : 'Dev-User';
  return {
    status: 'pass',
    detail: `ready nach ${seconds(start.durationMs)} — Login verifiziert (${email}).`,
  };
};
