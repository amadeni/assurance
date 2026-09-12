import { describe, expect, it } from 'vitest';

import {
  CHECK_RUN_NAME,
  embedReport,
  extractReport,
  isForkPullRequest,
  publishCheckRun,
  resolveGithubContext,
} from './github.js';
import { renderMarkdown, summaryLine, type Report } from './report.js';

const report: Report = {
  contract: 1,
  package: '@amadeni/assurance@0.1.0',
  catalogVersion: 1,
  declaredLevel: 'standard',
  level: 'standard',
  ok: false,
  executed: true,
  results: [
    {
      feature: 'ci-gate',
      title: 'CI-Gate',
      class: 'structure',
      level: 'basis',
      verifier: 'local',
      status: 'pass',
      detail: 'Job `test` vorhanden.',
    },
    {
      feature: 'dev-contract',
      title: 'Dev-Backend per just',
      class: 'structure',
      level: 'standard',
      verifier: 'local',
      status: 'fail',
      detail: 'devcontract.config.json fehlt | Pipe.',
    },
  ],
  catalog: [
    {
      id: 'ci-gate',
      title: 'CI-Gate',
      class: 'structure',
      level: 'basis',
      verifier: 'local',
      maturity: 'active',
      promise: 'p',
      rationale: 'r',
      reference: 'ref',
      remedy: 'rem',
    },
  ],
};

describe('Report im Check-Run', () => {
  it('überlebt die Reise durch den Check-Run-Text', () => {
    const text = `Vorspann\n${embedReport(report)}\nNachspann`;
    expect(extractReport(text)).toEqual(report);
  });

  it('gibt null statt eines geratenen Reports', () => {
    expect(extractReport(null)).toBeNull();
    expect(extractReport('kein Block')).toBeNull();
    expect(extractReport('```json\n{"contract":2}\n```')).toBeNull();
    expect(extractReport('```json\n{"contract":1,"ok":true}\n```')).toBeNull();
    expect(
      extractReport(
        embedReport({
          ...report,
          results: [{ ...report.results[0]!, status: 'maybe' as never }],
        }),
      ),
    ).toBeNull();
    expect(
      extractReport(
        embedReport({
          ...report,
          results: [{ ...report.results[0]!, verifier: 'magic' as never }],
        }),
      ),
    ).toBeNull();
    expect(
      extractReport(
        embedReport({
          ...report,
          catalog: [{ ...report.catalog[0]!, remedy: 7 as never }],
        }),
      ),
    ).toBeNull();
  });

  it('erkennt PRs aus Forks am Event', () => {
    const env = { GITHUB_EVENT_PATH: '/e.json' };
    const event = (head: string, base: string, fork = false) =>
      JSON.stringify({
        pull_request: {
          head: { repo: { full_name: head, fork } },
          base: { repo: { full_name: base } },
        },
      });
    expect(isForkPullRequest(env, () => event('x/y', 'a/b'))).toBe(true);
    expect(isForkPullRequest(env, () => event('a/b', 'a/b', true))).toBe(true);
    expect(isForkPullRequest(env, () => event('a/b', 'a/b'))).toBe(false);
    expect(isForkPullRequest(env, () => '{"ref":"refs/heads/main"}')).toBe(
      false,
    );
    expect(isForkPullRequest({})).toBe(false);
  });

  it('rendert Zusammenfassung und Tabelle ohne kaputte Pipes', () => {
    expect(summaryLine(report)).toContain('1 Feature(s) fallen durch');
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('| ✘ | `dev-contract` | fail |');
    expect(markdown).toContain('fehlt \\| Pipe');
  });
});

describe('GitHub-Kontext', () => {
  const env = {
    GITHUB_REPOSITORY: 'amadeni/zeitreise',
    GITHUB_TOKEN: 't',
    GITHUB_SHA: 'a'.repeat(40),
  };

  it('nimmt bei pull_request den Kopf des PR-Branches', () => {
    const context = resolveGithubContext(
      { ...env, GITHUB_EVENT_PATH: '/event.json' },
      () => JSON.stringify({ pull_request: { head: { sha: 'b'.repeat(40) } } }),
    );
    expect(context).toMatchObject({
      sha: 'b'.repeat(40),
      apiUrl: 'https://api.github.com',
    });
    const push = resolveGithubContext(
      { ...env, GITHUB_EVENT_PATH: '/event.json' },
      () => JSON.stringify({ ref: 'refs/heads/main' }),
    );
    expect(push).toMatchObject({ sha: 'a'.repeat(40) });
  });

  it('sagt, was fehlt', () => {
    expect(resolveGithubContext({})).toContain('GITHUB_REPOSITORY');
    expect(resolveGithubContext({ GITHUB_REPOSITORY: 'a/b' })).toContain(
      'GITHUB_TOKEN',
    );
    expect(resolveGithubContext({ ...env, GITHUB_SHA: 'main' })).toContain(
      'Commit',
    );
  });

  it('legt den Check-Run mit Ergebnis, Tabelle und JSON an', async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ html_url: 'https://x/1' }), {
        status: 201,
      });
    }) as typeof fetch;
    const context = resolveGithubContext(env);
    if (typeof context === 'string') throw new Error(context);
    const result = await publishCheckRun(report, context, fetchImpl);
    expect(result).toEqual({ ok: true, url: 'https://x/1' });
    expect(requests[0]!.url).toBe(
      'https://api.github.com/repos/amadeni/zeitreise/check-runs',
    );
    expect(requests[0]!.body).toMatchObject({
      name: CHECK_RUN_NAME,
      head_sha: 'a'.repeat(40),
      status: 'completed',
      conclusion: 'failure',
    });
    const output = requests[0]!.body.output as { text: string };
    expect(extractReport(output.text)).toEqual(report);

    const denied = await publishCheckRun(
      report,
      context,
      (async () =>
        new Response('Resource not accessible by integration', {
          status: 403,
        })) as typeof fetch,
    );
    expect(denied).toMatchObject({ ok: false });
    expect((denied as { error: string }).error).toContain('403');
  });
});
