import { describe, expect, it } from 'vitest';

import { satisfiesFloor } from './semver.js';

describe('Floors', () => {
  it('vergleicht konkrete und Caret-Versionen', () => {
    expect(satisfiesFloor('0.4.2', '0.4.2')).toBe(true);
    expect(satisfiesFloor('^0.4.1', '0.4.2')).toBe(false);
    expect(satisfiesFloor('~1.0.0', '0.9.9')).toBe(true);
    expect(satisfiesFloor('>=0.1.8', '0.1.8')).toBe(true);
  });

  it('gibt bei unvergleichbaren Angaben null zurück', () => {
    expect(satisfiesFloor('workspace:*', '0.1.0')).toBeNull();
    expect(satisfiesFloor('github:amadeni/x', '0.1.0')).toBeNull();
    expect(satisfiesFloor('latest', '0.1.0')).toBeNull();
    expect(satisfiesFloor('>=0.4.2 || ^0.1.0', '0.4.2')).toBeNull();
    expect(satisfiesFloor('npm:@other/pkg@1.0.0', '0.1.0')).toBeNull();
  });
});
