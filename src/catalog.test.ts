import { describe, expect, it } from 'vitest';

import {
  FEATURES,
  LEVELS,
  PACKAGE_FLOORS,
  levelRank,
  requiredFeatures,
} from './catalog.js';
import { CHECKS } from './report.js';

describe('Katalog', () => {
  it('hat eindeutige Feature-IDs', () => {
    const ids = FEATURES.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hat für jedes aktive lokale oder ausgeführte Feature eine Prüfung und für kein anderes', () => {
    const local = FEATURES.filter(
      f => f.verifier !== 'fleet' && f.maturity === 'active',
    ).map(f => f.id);
    expect(Object.keys(CHECKS).sort()).toEqual([...local].sort());
  });

  it('baut die Stufen aufeinander auf', () => {
    expect(LEVELS.map(levelRank)).toEqual([0, 1, 2]);
    const basis = requiredFeatures('basis').map(f => f.id);
    const standard = requiredFeatures('standard').map(f => f.id);
    const voll = requiredFeatures('voll').map(f => f.id);
    expect(standard).toEqual(expect.arrayContaining(basis));
    expect(voll).toEqual(expect.arrayContaining(standard));
    expect(voll.length).toBe(FEATURES.length);
  });

  it('nennt für jedes Feature Zusage, Warum, Referenz und Abhilfe', () => {
    for (const feature of FEATURES) {
      expect(feature.promise.length).toBeGreaterThan(30);
      expect(feature.rationale.length).toBeGreaterThan(30);
      expect(feature.reference.length).toBeGreaterThan(5);
      expect(feature.remedy.length).toBeGreaterThan(20);
    }
  });

  it('hat nur konkrete Floors', () => {
    for (const [name, floor] of Object.entries(PACKAGE_FLOORS)) {
      expect(name.startsWith('@amadeni/')).toBe(true);
      expect(floor).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
