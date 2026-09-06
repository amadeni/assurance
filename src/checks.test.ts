import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CheckContext } from './checks.js';
import { lastJsonLine, lastStepLine, type CommandRunner } from './exec.js';
import { CHECKS, runChecks } from './report.js';
import { fsRepo } from './repo.js';

const neverRun: CommandRunner = () =>
  Promise.reject(new Error('kein Runner in diesem Test'));

const staticCtx: CheckContext = {
  exec: false,
  execTimeoutMs: 1,
  run: neverRun,
};

const READY =
  '{"ok":true,"baseUrl":"http://localhost:3004","auth":{"email":"admin@zeitreise.test","cookies":{"better-auth.session_token":"x"}}}';

function fakeRunner(
  outcome: {
    code: number;
    stdout?: string;
    stderr?: string;
    timedOut?: boolean;
  },
  calls: string[][] = [],
): CommandRunner {
  return (command, args) => {
    calls.push([command, ...args]);
    const isStart = args.includes('start');
    return Promise.resolve({
      code: isStart ? outcome.code : 0,
      stdout: isStart ? (outcome.stdout ?? '') : '{"ok":true}',
      stderr: isStart ? (outcome.stderr ?? '') : '',
      timedOut: isStart ? (outcome.timedOut ?? false) : false,
      durationMs: 1234,
    });
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

type Files = Record<string, string | object>;

function repoWith(files: Files) {
  const root = mkdtempSync(join(tmpdir(), 'assurance-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return fsRepo(root);
}

const WORKFLOW = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm run ci
      - run: pnpm dlx @amadeni/assurance@0.1 check
`;

const compliant: Files = {
  'package.json': {
    scripts: {
      ci: 'pnpm run prettier:check && pnpm run lint && pnpm run ts && pnpm run test',
      'test:e2e': 'bash cli-test/local-backend.sh',
      'ps:codegen': 'tsx tools/ps-codegen/generate.ts',
    },
    dependencies: {
      '@amadeni/better-auth-kit': '0.4.2',
      '@amadeni/convex-lib': '^0.1.8',
    },
    devDependencies: {
      '@amadeni/dev-contract': '0.1.0',
      '@amadeni/convex-e2e': '^0.1.4',
    },
  },
  '.github/workflows/ci.yml': WORKFLOW,
  'devcontract.config.json': { appUrl: 'http://localhost:3000' },
  justfile: 'ci:\n\tpnpm run ci\n\ndev:\n\tpnpm exec dev-contract start\n',
  'convex/auth.ts':
    "import { createAmadeniAuthOptions, createResendMagicLinkSender } from '@amadeni/better-auth-kit';\nexport const options = createAmadeniAuthOptions({ sendMagicLink: createResendMagicLinkSender({}) });",
  'convex/dev/auth.ts':
    "import { createDevAuth } from '@amadeni/better-auth-kit';\nconst devAuth = createDevAuth<ActionCtx>({});",
  'convex/core.ts': "import { step } from '../shared/core/core.gen.mjs';",
  'cli-test/run.ts': 'run();',
  'purescript/spago.yaml': 'package: core',
  'shared/core/core.gen.mjs': 'export const x = 1;',
};

describe('Prüfungen', () => {
  it('ein vollständiges Repo besteht jede Prüfung', async () => {
    const repo = repoWith(compliant);
    for (const [id, check] of Object.entries(CHECKS)) {
      const ctx =
        id === 'login-verified'
          ? {
              exec: true,
              execTimeoutMs: 1,
              run: fakeRunner({ code: 0, stdout: READY }),
            }
          : staticCtx;
      expect({ id, ...(await check(repo, ctx)) }).toMatchObject({
        id,
        status: 'pass',
      });
    }
  });

  it('ci-gate nennt, was am Gate fehlt', async () => {
    const repo = repoWith({
      'package.json': { scripts: { ci: 'pnpm run lint' } },
      '.github/workflows/ci.yml': 'jobs:\n  build:\n    steps: []\n',
    });
    const outcome = await CHECKS['ci-gate']!(repo, staticCtx);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('prettier:check');
    expect(outcome.detail).toContain('Job `test`');
  });

  it('ci-gate verlangt ci und assurance im Job test, nicht irgendwo', async () => {
    const repo = repoWith({
      'package.json': { scripts: { ci: 'prettier lint ts test' } },
      '.github/workflows/ci.yml':
        'jobs:\n  test:\n    steps:\n      - run: echo ok\n  extra:\n    steps:\n      - run: pnpm run ci\n      - run: pnpm dlx @amadeni/assurance@0.1.0 check\n',
    });
    const outcome = await CHECKS['ci-gate']!(repo, staticCtx);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain(
      'Job `test` führt `pnpm run ci` nicht aus',
    );
    expect(outcome.detail).toContain(
      'Job `test` führt `assurance check` nicht aus',
    );
  });

  it('ci-gate findet Workflows im Monorepo-Root', async () => {
    const repo = repoWith({
      ...compliant,
      'apps/web/package.json': compliant['package.json'] as object,
    });
    const app = fsRepo(join(repo.root, 'apps', 'web'));
    expect((await CHECKS['ci-gate']!(app, staticCtx)).status).toBe('pass');
  });

  it('package-floors meldet Versionen unter Floor, unprüfbare Angaben, ignoriert workspace', async () => {
    const repo = repoWith({
      'package.json': {
        dependencies: {
          '@amadeni/better-auth-kit': '0.3.9',
          '@amadeni/convex-lib': 'workspace:*',
          '@amadeni/convex-e2e': 'latest',
        },
      },
    });
    const outcome = await CHECKS['package-floors']!(repo, staticCtx);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('@amadeni/better-auth-kit 0.3.9 < 0.4.2');
    expect(outcome.detail).toContain(
      '@amadeni/convex-e2e „latest“ ist keine prüfbare Version',
    );
    expect(outcome.detail).not.toContain('convex-lib');
  });

  it('auth-kit lässt auskommentierten Code und fehlende Kit-Importe nicht gelten', async () => {
    const repo = repoWith({
      'package.json': { dependencies: { '@amadeni/better-auth-kit': '0.4.2' } },
      'convex/auth.ts':
        '// createAmadeniAuthOptions({})\n/* createDevAuth({}) */\nexport const x = createAmadeniAuthOptions({});',
    });
    const outcome = await CHECKS['auth-kit']!(repo, staticCtx);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('createAmadeniAuthOptions aus dem Kit');
    expect(outcome.detail).toContain('createDevAuth');
  });

  it('e2e-cli-test und purescript-core lassen sich nicht mit Platzhaltern erfüllen', async () => {
    const repo = repoWith({
      'package.json': {
        scripts: { 'test:e2e': 'echo ok', 'ps:codegen': 'echo ok' },
        devDependencies: { '@amadeni/convex-e2e': '^0.1.4' },
      },
      'cli-test': '',
      'purescript/spago.yaml': '',
      'shared/core/core.gen.mjs': '',
    });
    expect(CHECKS['e2e-cli-test']!(repo).detail).toContain('leer');
    expect(CHECKS['e2e-cli-test']!(repo).detail).toContain('weder cli-test/');
    const ps = await CHECKS['purescript-core']!(repo, staticCtx);
    expect(ps.status).toBe('fail');
    expect(ps.detail).toContain('importiert das generierte Kern-Bundle nicht');
    expect(ps.detail).toContain('ps:codegen');
  });

  it('dev-contract verlangt das just-Rezept, nicht nur das Paket', async () => {
    const repo = repoWith({
      'package.json': { devDependencies: { '@amadeni/dev-contract': '0.1.0' } },
      'devcontract.config.json': {},
      justfile: 'dev-start:\n\tbash scripts/dev-start.sh\n',
    });
    const outcome = await CHECKS['dev-contract']!(repo, staticCtx);
    expect(outcome.status).toBe('fail');
    expect(outcome.detail).toContain('just-Rezept');
  });

  it('login-mail unterscheidet Kit-Mail von eigener Mail', async () => {
    const repo = repoWith({
      'package.json': { dependencies: { '@amadeni/better-auth-kit': '0.4.2' } },
      'convex/auth.ts':
        'createAmadeniAuthOptions({ sendMagicLink: async () => sendMyOwnMail() });',
    });
    expect((await CHECKS['login-mail']!(repo, staticCtx)).status).toBe('fail');
  });
});

describe('Report', () => {
  it('ordnet Status nach Stufe, Ausnahme und Prüfer', async () => {
    const repo = repoWith({
      'package.json': { scripts: { ci: 'prettier lint ts test' } },
      '.github/workflows/ci.yml': WORKFLOW,
    });
    const report = await runChecks(
      repo,
      {
        catalogVersion: 1,
        level: 'standard',
        waived: [{ feature: 'e2e-cli-test', reason: 'reine Landingpage' }],
      },
      { today: '2026-09-04', exec: false, run: neverRun },
    );
    const status = Object.fromEntries(
      report.results.map(r => [r.feature, r.status]),
    );
    expect(status).toMatchObject({
      'ci-gate': 'pass',
      'repo-standard': 'fleet',
      'package-floors': 'pass',
      'dev-contract': 'fail',
      'login-verified': 'skipped',
      'e2e-cli-test': 'waived',
      'ui-components': 'not-required',
      'purescript-core': 'not-required',
    });
    expect(report.ok).toBe(false);
    expect(report.executed).toBe(false);
    expect(report.contract).toBe(1);
    expect(report.declaredLevel).toBe('standard');
    expect(report.catalog.map(f => f.id)).toContain('login-verified');
  });

  it('ist grün, wenn nur Ausnahmen und Fleet-Prüfungen übrig sind', async () => {
    const repo = repoWith(compliant);
    const report = await runChecks(
      repo,
      {
        catalogVersion: 1,
        level: 'voll',
        waived: [],
      },
      { run: fakeRunner({ code: 0, stdout: READY }) },
    );
    expect(report.executed).toBe(true);
    expect(report.results.map(r => r.status)).not.toContain('fail');
    expect(report.ok).toBe(true);
    expect(
      report.results.find(r => r.feature === 'ui-components')?.status,
    ).toBe('planned');
  });
});

describe('login-verified (ausgeführt)', () => {
  const project: Files = {
    'package.json': { devDependencies: { '@amadeni/dev-contract': '0.1.0' } },
    'devcontract.config.json': { appUrl: 'http://localhost:3004' },
  };
  const ctx = (run: CommandRunner): CheckContext => ({
    exec: true,
    execTimeoutMs: 5_000,
    run,
  });

  it('startet, verlangt ready mit Cookies und stoppt danach', async () => {
    const calls: string[][] = [];
    const outcome = await CHECKS['login-verified']!(
      repoWith(project),
      ctx(fakeRunner({ code: 0, stdout: `log\n${READY}` }, calls)),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.detail).toContain('admin@zeitreise.test');
    expect(calls).toEqual([
      ['pnpm', 'exec', 'dev-contract', 'start'],
      ['pnpm', 'exec', 'dev-contract', 'stop'],
    ]);
  });

  it('nennt den [step]-Befund, wenn der Start scheitert oder hängt', async () => {
    const failed = await CHECKS['login-verified']!(
      repoWith(project),
      ctx(
        fakeRunner({
          code: 1,
          stderr: '[convex-ready] ok\n[seed] seedDevData threw: boom\n',
        }),
      ),
    );
    expect(failed.status).toBe('fail');
    expect(failed.detail).toContain('[seed] seedDevData threw: boom');
    const hung = await CHECKS['login-verified']!(
      repoWith(project),
      ctx(fakeRunner({ code: null as unknown as number, timedOut: true })),
    );
    expect(hung.status).toBe('fail');
    expect(hung.detail).toContain('nicht ready gemeldet');
  });

  it('lässt ready ohne Sitzung nicht gelten und meldet skipped ohne exec', async () => {
    const noCookies = await CHECKS['login-verified']!(
      repoWith(project),
      ctx(fakeRunner({ code: 0, stdout: '{"ok":true,"auth":{"cookies":{}}}' })),
    );
    expect(noCookies.status).toBe('fail');
    const skipped = await CHECKS['login-verified']!(
      repoWith(project),
      staticCtx,
    );
    expect(skipped.status).toBe('skipped');
    const missing = await CHECKS['login-verified']!(
      repoWith({ 'package.json': {} }),
      ctx(neverRun),
    );
    expect(missing.status).toBe('fail');
    expect(missing.detail).toContain('dev-contract');
  });

  it('liest die letzte JSON-Zeile und den letzten [step]', () => {
    expect(lastJsonLine('noise\n{"ok":true}\n')).toEqual({ ok: true });
    expect(lastJsonLine('noise')).toBeNull();
    expect(lastStepLine('[a] one\nplain\n[b-c] two\n')).toBe('[b-c] two');
    expect(lastStepLine('')).toBeNull();
  });
});
