// Ein Lauf über den Katalog: pro Feature ein Ergebnis, plus der Katalog
// selbst. Der Report ist der Vertrag nach außen (Check-Run `assurance`,
// --json, --out): FlightControl urteilt daraus, mynd baut die Matrix daraus
// — beide ohne eigene Katalog-Kopie. `contract` steigt nur bei einem Bruch
// dieses Formats.

import { createRequire } from 'node:module';

import {
  CATALOG_VERSION,
  FEATURES,
  levelRank,
  type Feature,
  type Level,
} from './catalog.js';
import {
  STATIC_CHECKS,
  type Check,
  type CheckContext,
  type CheckOutcome,
} from './checks.js';
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  loginVerified,
  spawnRunner,
  type CommandRunner,
} from './exec.js';
import { activeWaiver, type Manifest } from './manifest.js';
import type { RepoView } from './repo.js';

export const REPORT_CONTRACT = 1;

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json') as {
  version: string;
};

export const PACKAGE_ID = `@amadeni/assurance@${PACKAGE_VERSION}`;

/** Alle Prüfungen: statische (`local`) und ausgeführte (`exec`). */
export const CHECKS: Readonly<Record<string, Check>> = {
  ...STATIC_CHECKS,
  'login-verified': loginVerified,
};

export type ResultStatus =
  'pass' | 'fail' | 'waived' | 'fleet' | 'planned' | 'not-required' | 'skipped';

export type FeatureResult = {
  feature: string;
  title: string;
  class: Feature['class'];
  level: Level;
  verifier: Feature['verifier'];
  status: ResultStatus;
  detail: string;
};

export type Report = {
  contract: typeof REPORT_CONTRACT;
  package: string;
  catalogVersion: number;
  /** Was assurance.json deklariert. */
  declaredLevel: Level;
  /** Wogegen geprüft wurde (nie unter der deklarierten Stufe). */
  level: Level;
  ok: boolean;
  /** Ob ausgeführte Prüfungen liefen; false heißt: `skipped` im Report. */
  executed: boolean;
  results: FeatureResult[];
  catalog: Feature[];
};

export type RunOptions = {
  /** Prüft gegen eine andere Stufe als die deklarierte (Vorschau). */
  level?: Level;
  /** YYYY-MM-DD; Standard: heute (UTC). */
  today?: string;
  /** Ausgeführte Prüfungen laufen lassen (Standard: ja). */
  exec?: boolean;
  execTimeoutMs?: number;
  run?: CommandRunner;
};

const todayIso = (): string => new Date().toISOString().slice(0, 10);

async function evaluate(
  feature: Feature,
  repo: RepoView,
  manifest: Manifest,
  level: Level,
  today: string,
  ctx: CheckContext,
): Promise<FeatureResult> {
  const base = {
    feature: feature.id,
    title: feature.title,
    class: feature.class,
    level: feature.level,
    verifier: feature.verifier,
  };
  if (levelRank(feature.level) > levelRank(level))
    return {
      ...base,
      status: 'not-required',
      detail: `erst ab Stufe ${feature.level}`,
    };
  if (feature.maturity === 'planned')
    return { ...base, status: 'planned', detail: feature.reference };
  const waiver = activeWaiver(manifest, feature.id, today);
  if (waiver)
    return {
      ...base,
      status: 'waived',
      detail: `Ausnahme: ${waiver.reason}${waiver.until ? ` (bis ${waiver.until})` : ''}`,
    };
  if (feature.verifier === 'fleet')
    return {
      ...base,
      status: 'fleet',
      detail: `prüft FlightControl — ${feature.reference}`,
    };
  const check = CHECKS[feature.id];
  if (!check)
    return {
      ...base,
      status: 'fail',
      detail: 'Katalog-Fehler: lokal prüfbares Feature ohne Prüfung.',
    };
  const outcome: CheckOutcome = await check(repo, ctx);
  const expired = manifest.waived.find(
    w => w.feature === feature.id && w.until !== undefined && w.until < today,
  );
  return {
    ...base,
    status: outcome.status,
    detail:
      outcome.detail +
      (expired && outcome.status === 'fail'
        ? ` Ausnahme abgelaufen am ${expired.until}.`
        : ''),
  };
}

export async function runChecks(
  repo: RepoView,
  manifest: Manifest,
  options: RunOptions = {},
): Promise<Report> {
  const level = options.level ?? manifest.level;
  const today = options.today ?? todayIso();
  const ctx: CheckContext = {
    exec: options.exec ?? true,
    execTimeoutMs: options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    run: options.run ?? spawnRunner,
  };
  const results: FeatureResult[] = [];
  for (const feature of FEATURES)
    results.push(await evaluate(feature, repo, manifest, level, today, ctx));
  return {
    contract: REPORT_CONTRACT,
    package: PACKAGE_ID,
    catalogVersion: CATALOG_VERSION,
    declaredLevel: manifest.level,
    level,
    ok: results.every(result => result.status !== 'fail'),
    executed: ctx.exec,
    results,
    catalog: [...FEATURES],
  };
}

export const MARK: Record<ResultStatus, string> = {
  pass: '✔',
  fail: '✘',
  waived: '◌',
  fleet: '⇡',
  planned: '…',
  'not-required': '·',
  skipped: '○',
};

export function summaryLine(report: Report): string {
  const failed = report.results.filter(r => r.status === 'fail').length;
  const skipped = report.results.filter(r => r.status === 'skipped').length;
  const tail = skipped ? ` ${skipped} nicht ausgeführt (--no-exec).` : '';
  return report.ok
    ? `Assurance ${report.level}: erfüllt (Katalog ${report.catalogVersion}).${tail}`
    : `Assurance ${report.level}: ${failed} Feature(s) fallen durch (Katalog ${report.catalogVersion}).${tail}`;
}

export function renderReport(report: Report): string {
  const lines = report.results.map(
    result =>
      `${MARK[result.status]} ${result.feature.padEnd(16)} ${result.status.padEnd(12)} ${result.detail}`,
  );
  lines.push(summaryLine(report));
  return lines.join('\n');
}

/** Markdown-Tabelle für den Check-Run — das, was man auf GitHub liest. */
export function renderMarkdown(report: Report): string {
  const rows = report.results
    .filter(result => result.status !== 'not-required')
    .map(
      result =>
        `| ${MARK[result.status]} | \`${result.feature}\` | ${result.status} | ${result.detail.replace(/\|/g, '\\|')} |`,
    );
  return [
    `**${summaryLine(report)}**`,
    '',
    `Deklariert: \`${report.declaredLevel}\` · geprüft: \`${report.level}\` · ${report.package}`,
    '',
    '| | Feature | Status | Detail |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}
