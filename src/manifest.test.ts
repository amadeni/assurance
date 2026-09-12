import { describe, expect, it } from 'vitest';

import { CATALOG_VERSION } from './catalog.js';
import { activeWaiver, parseManifest, renderManifest } from './manifest.js';

describe('Manifest', () => {
  it('liest ein minimales Manifest', () => {
    const result = parseManifest('{"catalogVersion":1,"level":"standard"}');
    expect(result).toEqual({
      ok: true,
      value: { catalogVersion: 1, level: 'standard', waived: [] },
    });
  });

  it('lehnt eine unbekannte Stufe und einen neueren Katalog ab', () => {
    expect(parseManifest('{"catalogVersion":1,"level":"gold"}')).toMatchObject({
      ok: false,
      error: expect.stringContaining('level'),
    });
    expect(
      parseManifest(
        `{"catalogVersion":${CATALOG_VERSION + 1},"level":"basis"}`,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('neuer') });
  });

  it('verlangt Grund und bekannte Feature-ID für Ausnahmen', () => {
    expect(
      parseManifest(
        '{"catalogVersion":1,"level":"voll","waived":[{"feature":"nope","reason":"x"}]}',
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('nope') });
    expect(
      parseManifest(
        '{"catalogVersion":1,"level":"voll","waived":[{"feature":"purescript-core","reason":" "}]}',
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('Grund') });
    expect(
      parseManifest(
        '{"catalogVersion":1,"level":"voll","waived":[{"feature":"purescript-core","reason":"kein Fachkern","until":"bald"}]}',
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('YYYY') });
    expect(
      parseManifest(
        '{"catalogVersion":1,"level":"voll","waived":[{"feature":"purescript-core","reason":"kein Fachkern","until":"2026-99-99"}]}',
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('YYYY') });
  });

  it('lässt abgelaufene Ausnahmen nicht mehr gelten', () => {
    const manifest = {
      catalogVersion: 1,
      level: 'voll' as const,
      waived: [
        { feature: 'purescript-core', reason: 'später', until: '2026-01-31' },
        { feature: 'e2e-cli-test', reason: 'dauerhaft' },
      ],
    };
    expect(
      activeWaiver(manifest, 'purescript-core', '2026-01-31'),
    ).toBeDefined();
    expect(
      activeWaiver(manifest, 'purescript-core', '2026-02-01'),
    ).toBeUndefined();
    expect(activeWaiver(manifest, 'e2e-cli-test', '2030-01-01')).toBeDefined();
  });

  it('rendert stabil mit Zeilenumbruch am Ende', () => {
    const text = renderManifest({
      catalogVersion: 1,
      level: 'basis',
      waived: [],
    });
    expect(text.endsWith('\n')).toBe(true);
    expect(parseManifest(text)).toMatchObject({ ok: true });
  });
});
