// `assurance check` läuft im CI jedes Projekts (Job `test`) und lokal per
// `just assurance`. Exit 1 = mindestens ein Feature fällt durch, Exit 2 =
// Manifest oder Aufruf kaputt. Mit --json wandert der Report als letzte
// Zeile nach stdout (Muster dev-contract), alles andere geht nach stderr.
// --github legt den Report als Check-Run `assurance` am Commit an.

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  CATALOG_VERSION,
  FEATURES,
  isLevel,
  levelRank,
  type Level,
} from './catalog.js';
import { DEFAULT_EXEC_TIMEOUT_MS } from './exec.js';
import {
  isForkPullRequest,
  publishCheckRun,
  resolveGithubContext,
} from './github.js';
import {
  MANIFEST_FILE,
  parseManifest,
  parseManifestValue,
  renderManifest,
} from './manifest.js';
import { PACKAGE_ID, renderReport, runChecks } from './report.js';
import { fsRepo } from './repo.js';

type Args = {
  command: string;
  root: string;
  json: boolean;
  github: boolean;
  exec: boolean;
  execTimeoutMs: number;
  level?: Level;
  out?: string;
};

const USAGE = [
  'assurance check   [--root dir] [--level basis|standard|voll] [--json] [--out file]',
  '                  [--github] [--no-exec] [--exec-timeout sekunden]',
  'assurance init    [--root dir] --level basis|standard|voll',
  'assurance catalog',
  '',
  '--github    Report als Check-Run `assurance` am Commit anlegen (GITHUB_TOKEN, checks: write)',
  '--no-exec   ausgeführte Prüfungen (Dev-Start) überspringen — Status `skipped`, nicht `pass`',
].join('\n');

export function parseArgs(argv: string[]): Args | string {
  const [command = 'check', ...rest] = argv;
  const args: Args = {
    command,
    root: process.cwd(),
    json: false,
    github: false,
    exec: true,
    execTimeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const next = rest[i + 1];
    if (flag === '--json') args.json = true;
    else if (flag === '--github') args.github = true;
    else if (flag === '--no-exec') args.exec = false;
    else if (flag === '--exec-timeout' && next) {
      const secondsValue = Number(next);
      if (!Number.isFinite(secondsValue) || secondsValue <= 0)
        return `--exec-timeout braucht Sekunden > 0, nicht „${next}“.`;
      args.execTimeoutMs = secondsValue * 1000;
      i += 1;
    } else if (flag === '--root' && next) {
      args.root = resolve(next);
      i += 1;
    } else if (flag === '--out' && next) {
      args.out = resolve(next);
      i += 1;
    } else if (flag === '--level' && next) {
      if (!isLevel(next)) return `Unbekannte Stufe „${next}“.`;
      args.level = next;
      i += 1;
    } else return `Unbekanntes Argument „${flag}“.`;
  }
  return args;
}

function catalogText(): string {
  return FEATURES.map(
    f =>
      `${f.id.padEnd(16)} ${f.level.padEnd(9)} ${f.class.padEnd(12)} ${f.verifier.padEnd(6)} ${f.maturity === 'planned' ? '(geplant) ' : ''}${f.title}\n${' '.repeat(17)}${f.promise}`,
  )
    .concat(`Katalog ${CATALOG_VERSION} · ${PACKAGE_ID}`)
    .join('\n');
}

const err = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') {
    err(`${parsed}\n${USAGE}`);
    return 2;
  }
  if (parsed.command === 'catalog') {
    process.stdout.write(`${catalogText()}\n`);
    return 0;
  }
  if (parsed.command === 'init') {
    if (!parsed.level) {
      err(`init braucht --level.\n${USAGE}`);
      return 2;
    }
    const file = join(parsed.root, MANIFEST_FILE);
    const repo = fsRepo(parsed.root);
    if (repo.exists(MANIFEST_FILE)) {
      err(`${file} existiert schon.`);
      return 2;
    }
    writeFileSync(
      file,
      renderManifest({
        catalogVersion: CATALOG_VERSION,
        level: parsed.level,
        waived: [],
      }),
    );
    err(`${file} angelegt (Stufe ${parsed.level}).`);
    return 0;
  }
  if (parsed.command !== 'check') {
    err(`Unbekannter Befehl „${parsed.command}“.\n${USAGE}`);
    return 2;
  }
  const repo = fsRepo(parsed.root);
  const text = repo.read(MANIFEST_FILE);
  // Ohne Manifest ist --level eine Vorschau (Erhebung über die Flotte):
  // geprüft wird gegen die genannte Stufe, ohne Ausnahmen.
  if (text === null && !parsed.level) {
    err(
      `${MANIFEST_FILE} fehlt in ${parsed.root} — \`assurance init --level basis\` legt es an; \`--level <stufe>\` prüft ohne Manifest.`,
    );
    return 2;
  }
  const manifest =
    text === null
      ? parseManifestValue({
          catalogVersion: CATALOG_VERSION,
          level: parsed.level,
          waived: [],
        })
      : parseManifest(text);
  if (!manifest.ok) {
    err(manifest.error);
    return 2;
  }
  if (text === null)
    err(`Vorschau ohne ${MANIFEST_FILE} gegen Stufe ${parsed.level}.`);
  // Eine Vorschau darf strenger prüfen als deklariert, nie lockerer: sonst
  // ließe sich die deklarierte Stufe per Flag unterlaufen.
  const level =
    parsed.level && levelRank(parsed.level) > levelRank(manifest.value.level)
      ? parsed.level
      : manifest.value.level;
  if (parsed.level && level !== parsed.level)
    err(
      `--level ${parsed.level} liegt unter der deklarierten Stufe ${level} — geprüft wird ${level}.`,
    );
  const report = await runChecks(repo, manifest.value, {
    level,
    exec: parsed.exec,
    execTimeoutMs: parsed.execTimeoutMs,
  });
  err(renderReport(report));
  const json = `${JSON.stringify(report)}\n`;
  if (parsed.out) writeFileSync(parsed.out, json);
  if (parsed.json) process.stdout.write(json);
  if (parsed.github) {
    // Ohne Check-Run haben FlightControl und mynd keinen Nachweis — das
    // ist ein Fehler des Laufs (Exit 2), außer bei PRs aus Forks, die
    // keinen Schreib-Token haben.
    const context = resolveGithubContext(process.env);
    const failure =
      typeof context === 'string'
        ? context
        : await publishCheckRun(report, context).then(published => {
            if (published.ok) {
              err(
                `Check-Run \`assurance\` angelegt${published.url ? `: ${published.url}` : ''}.`,
              );
              return null;
            }
            return published.error;
          });
    if (failure !== null) {
      if (isForkPullRequest(process.env)) {
        err(
          `Check-Run nicht angelegt (${failure}) — PR aus einem Fork, kein Schreib-Token; das Ergebnis gilt trotzdem.`,
        );
      } else {
        err(
          `Check-Run nicht angelegt: ${failure}. Der Job braucht \`permissions: checks: write\` und \`GITHUB_TOKEN\` im Schritt.`,
        );
        return 2;
      }
    }
  }
  return report.ok ? 0 : 1;
}
