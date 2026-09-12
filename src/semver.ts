// Gerade genug Semver für Floors: eine konkrete oder mit ^/~/>= versehene
// Version gegen eine Mindestversion vergleichen. Workspace-/Link-/Git-
// Angaben lassen sich nicht vergleichen und gelten als „nicht prüfbar“.

export type VersionParts = [number, number, number];

export function parseVersion(spec: string): VersionParts | null {
  // Genau eine Untergrenze: `1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`. Alles
  // mit Alternativen, Bereichen oder Tags ist keine prüfbare Angabe.
  const match = /^[\^~]?(?:>=)?v?(\d+)\.(\d+)\.(\d+)$/.exec(spec.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Paket aus demselben Monorepo — die Floor-Frage stellt sich nicht. */
export const isWorkspaceSpec = (spec: string): boolean =>
  spec.trim().startsWith('workspace:');

export function compareVersions(a: VersionParts, b: VersionParts): number {
  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}

/** null = nicht vergleichbar (workspace:, link:, git-URL, Tag). */
export function satisfiesFloor(spec: string, floor: string): boolean | null {
  const version = parseVersion(spec);
  const minimum = parseVersion(floor);
  if (!version || !minimum) return null;
  return compareVersions(version, minimum) >= 0;
}
