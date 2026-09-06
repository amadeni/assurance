import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { embedReport, extractReport } from './github.js';
import { runChecks } from './report.js';
import { fsRepo } from './repo.js';

// fixtures/report-v1.json ist der Vertrag nach außen: FlightControl und mynd
// testen ihre Leser gegen dieselbe Datei (Zwillingskopie, byte-identisch).
describe('Report-Fixture', () => {
  it('ist ein gültiger Report nach Vertrag 1 und überlebt den Check-Run', () => {
    const text = readFileSync(
      new URL('../fixtures/report-v1.json', import.meta.url),
      'utf8',
    );
    const report = extractReport('```json\n' + text.trim() + '\n```');
    expect(report).not.toBeNull();
    expect(report?.contract).toBe(1);
    expect(report?.results.map(r => r.feature)).toContain('login-verified');
    expect(report?.catalog.length).toBe(report?.results.length);
    expect(extractReport(embedReport(report!))).toEqual(report);
  });

  it('entspricht der Form, die runChecks heute erzeugt', async () => {
    const text = readFileSync(
      new URL('../fixtures/report-v1.json', import.meta.url),
      'utf8',
    );
    const fixture = JSON.parse(text) as Record<string, unknown>;
    const live = await runChecks(
      fsRepo(new URL('..', import.meta.url).pathname),
      { catalogVersion: 1, level: 'standard', waived: [] },
      { exec: false },
    );
    expect(Object.keys(fixture).sort()).toEqual(Object.keys(live).sort());
    expect(Object.keys((fixture.results as object[])[0]!).sort()).toEqual(
      Object.keys(live.results[0]!).sort(),
    );
    expect(Object.keys((fixture.catalog as object[])[0]!).sort()).toEqual(
      Object.keys(live.catalog[0]!).sort(),
    );
  });
});
