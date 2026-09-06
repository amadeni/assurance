// Der Report als Check-Run `assurance` am geprüften Commit. Damit sehen
// FlightControl und mynd pro Feature, was der CI-Lauf festgestellt hat —
// ohne Artefakt, ohne neuen Kanal, ohne Secret: der Workflow-Token reicht
// (`permissions: checks: write`). Der Required Check bleibt `test`; der
// Check-Run ist der Beleg, kein zweites Gate.

import { readFileSync } from 'node:fs';

import { LEVELS, type Level } from './catalog.js';
import {
  REPORT_CONTRACT,
  renderMarkdown,
  summaryLine,
  type Report,
  type ResultStatus,
} from './report.js';

export const CHECK_RUN_NAME = 'assurance';

const FENCE = '```';

/** Der Report als JSON-Block im Check-Run-Text — was Konsumenten parsen. */
export function embedReport(report: Report): string {
  return `${FENCE}json\n${JSON.stringify(report)}\n${FENCE}`;
}

const STATUSES: readonly ResultStatus[] = [
  'pass',
  'fail',
  'waived',
  'fleet',
  'planned',
  'not-required',
  'skipped',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Liest den Report aus dem Text eines Check-Runs zurück. Dieselbe Regel gilt
 * für jeden Konsumenten: kein Block, falscher Vertrag oder kaputte Form →
 * null, nie ein geratener Report.
 */
export function extractReport(text: string | null | undefined): Report | null {
  if (!text) return null;
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!match) return null;
  let json: unknown;
  try {
    json = JSON.parse(match[1]!);
  } catch {
    return null;
  }
  if (!isRecord(json) || json.contract !== REPORT_CONTRACT) return null;
  if (
    typeof json.catalogVersion !== 'number' ||
    typeof json.ok !== 'boolean' ||
    typeof json.executed !== 'boolean' ||
    typeof json.package !== 'string' ||
    !(LEVELS as readonly unknown[]).includes(json.level) ||
    !(LEVELS as readonly unknown[]).includes(json.declaredLevel) ||
    !Array.isArray(json.results) ||
    !Array.isArray(json.catalog)
  )
    return null;
  for (const result of json.results) {
    if (
      !isRecord(result) ||
      typeof result.feature !== 'string' ||
      typeof result.title !== 'string' ||
      typeof result.detail !== 'string' ||
      !(STATUSES as readonly unknown[]).includes(result.status)
    )
      return null;
  }
  return json as unknown as Report;
}

export type GithubContext = {
  repository: string;
  sha: string;
  token: string;
  apiUrl: string;
};

/**
 * Was ein Actions-Lauf mitbringt. Bei `pull_request` ist GITHUB_SHA der
 * Merge-Commit; der Check-Run gehört an den Kopf des PR-Branches, sonst
 * sieht ihn niemand.
 */
export function resolveGithubContext(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string = path => readFileSync(path, 'utf8'),
): GithubContext | string {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repository) return 'GITHUB_REPOSITORY fehlt';
  if (!token)
    return 'GITHUB_TOKEN fehlt — im Workflow-Schritt `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` setzen';
  let sha = env.GITHUB_SHA ?? '';
  if (env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(readFile(env.GITHUB_EVENT_PATH)) as {
        pull_request?: { head?: { sha?: string } };
      };
      const head = event.pull_request?.head?.sha;
      if (typeof head === 'string' && head) sha = head;
    } catch {
      // Ohne lesbares Event bleibt GITHUB_SHA.
    }
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) return 'GITHUB_SHA ist kein Commit';
  return {
    repository,
    sha,
    token,
    apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
  };
}

export type PublishResult =
  { ok: true; url: string | null } | { ok: false; error: string };

export async function publishCheckRun(
  report: Report,
  context: GithubContext,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  const response = await fetchImpl(
    `${context.apiUrl}/repos/${context.repository}/check-runs`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${context.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: CHECK_RUN_NAME,
        head_sha: context.sha,
        status: 'completed',
        conclusion: report.ok ? 'success' : 'failure',
        output: {
          title: summaryLine(report),
          summary: renderMarkdown(report),
          text: embedReport(report),
        },
      }),
    },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return {
      ok: false,
      error: `HTTP ${response.status} beim Anlegen des Check-Runs${text ? `: ${text.slice(0, 200)}` : ''}`,
    };
  }
  const body = (await response.json().catch(() => null)) as {
    html_url?: string;
  } | null;
  return { ok: true, url: body?.html_url ?? null };
}

export const levelOf = (value: unknown): Level | null =>
  (LEVELS as readonly unknown[]).includes(value) ? (value as Level) : null;
