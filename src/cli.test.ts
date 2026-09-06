import { describe, expect, it } from 'vitest';

import { parseArgs } from './cli.js';

describe('CLI-Argumente', () => {
  it('kennt Vorschau, Report, Check-Run und --no-exec', () => {
    expect(
      parseArgs([
        'check',
        '--level',
        'standard',
        '--json',
        '--github',
        '--no-exec',
        '--exec-timeout',
        '90',
      ]),
    ).toMatchObject({
      command: 'check',
      level: 'standard',
      json: true,
      github: true,
      exec: false,
      execTimeoutMs: 90_000,
    });
    expect(parseArgs([])).toMatchObject({ command: 'check', exec: true });
  });

  it('lehnt Unbekanntes mit einem Satz ab', () => {
    expect(parseArgs(['check', '--level', 'gold'])).toContain('gold');
    expect(parseArgs(['check', '--bogus'])).toContain('bogus');
    expect(parseArgs(['check', '--exec-timeout', '0'])).toContain('Sekunden');
  });
});
