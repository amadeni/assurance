// Sicht auf ein Repo, wie die Prüfungen sie brauchen: Dateien lesen,
// Verzeichnisse suchen, Inhalte durchsuchen. Die Prüfungen sind rein über
// dieser Schnittstelle, deshalb testen sie sich mit Temp-Verzeichnissen.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

export type PackageJson = {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export type RepoView = {
  root: string;
  exists: (rel: string) => boolean;
  read: (rel: string) => string | null;
  packageJson: () => PackageJson | null;
  /** Dateien unter `rel` (rekursiv, ohne node_modules/.git/dist), relativ zum Root. */
  files: (rel: string, depth?: number) => string[];
  /** CI-Workflows (absolute Pfade): `.github/workflows/*.yml` im Root oder bis zwei Ebenen darüber (Monorepo). */
  workflowFiles: () => string[];
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'output']);

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function walk(root: string, dir: string, depth: number, out: string[]) {
  // Eine Datei, die wie das Verzeichnis heißt, ist kein Verzeichnis.
  if (depth < 0 || !isDirectory(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(root, abs, depth - 1, out);
    else out.push(relative(root, abs));
  }
}

export function fsRepo(root: string): RepoView {
  // Workflow-Dateien kommen absolut (sie können über dem Root liegen).
  const read = (rel: string): string | null => {
    const abs = isAbsolute(rel) ? rel : join(root, rel);
    if (!existsSync(abs)) return null;
    try {
      return readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  };
  return {
    root,
    exists: rel => existsSync(join(root, rel)),
    read,
    packageJson: () => {
      const text = read('package.json');
      if (text === null) return null;
      try {
        return JSON.parse(text) as PackageJson;
      } catch {
        return null;
      }
    },
    files: (rel, depth = 6) => {
      const out: string[] = [];
      walk(root, join(root, rel), depth, out);
      return out.sort();
    },
    workflowFiles: () => {
      let dir = root;
      for (let up = 0; up <= 2; up += 1) {
        const workflows = join(dir, '.github', 'workflows');
        if (existsSync(workflows)) {
          return readdirSync(workflows)
            .filter(name => /\.ya?ml$/.test(name))
            .map(name => join(workflows, name))
            .sort();
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return [];
    },
  };
}

export const allDependencies = (
  pkg: PackageJson | null,
): Record<string, string> => ({
  ...(pkg?.dependencies ?? {}),
  ...(pkg?.devDependencies ?? {}),
});
