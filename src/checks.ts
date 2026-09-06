// Die lokalen Prüfungen, eine je Feature mit verifier `local` oder `exec`.
// Die statischen sind rein über RepoView; die ausgeführten (exec.ts)
// bekommen einen Runner. Jede antwortet mit einem Satz, der sagt, was
// fehlt — derselbe Satz landet im CI-Log, im Check-Run und im Auftrag an Echo.

import { PACKAGE_FLOORS } from './catalog.js';
import type { CommandRunner } from './exec.js';
import { allDependencies, type RepoView } from './repo.js';
import { isWorkspaceSpec, satisfiesFloor } from './semver.js';

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export type CheckOutcome = { status: CheckStatus; detail: string };

/** Was eine ausgeführte Prüfung braucht: ob sie laufen darf, womit, wie lange. */
export type CheckContext = {
  exec: boolean;
  execTimeoutMs: number;
  run: CommandRunner;
};

export type Check = (
  repo: RepoView,
  ctx: CheckContext,
) => CheckOutcome | Promise<CheckOutcome>;

const pass = (detail: string): CheckOutcome => ({ status: 'pass', detail });
const fail = (detail: string): CheckOutcome => ({ status: 'fail', detail });

const missing = (items: string[]): string => items.join(', ');

/** Quelltext ohne Block- und Zeilenkommentare — auskommentierter Code beweist nichts. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function grepFiles(
  repo: RepoView,
  dir: string,
  patterns: RegExp[],
  extensions = /\.(ts|tsx|mjs|js)$/,
): string[] {
  return repo
    .files(dir)
    .filter(file => extensions.test(file))
    .filter(file => {
      const code = stripComments(repo.read(file) ?? '');
      return patterns.every(pattern => pattern.test(code));
    });
}

const importsKit = /from\s+['"]@amadeni\/better-auth-kit['"]/;

/** Der Block des Jobs `test` in einem Workflow (bis zum nächsten Job). */
function testJobBlock(text: string): string | null {
  const match = /^ {2}test:[ \t]*\n([\s\S]*?)(?=^ {2}\S|(?![\s\S]))/m.exec(
    text,
  );
  return match ? match[1]! : null;
}

const ciGate: Check = repo => {
  const pkg = repo.packageJson();
  if (!pkg) return fail('package.json fehlt oder ist kein JSON.');
  const problems: string[] = [];
  const ci = pkg.scripts?.ci ?? '';
  if (!ci) problems.push('Script `ci` fehlt');
  else {
    const wanted: [string, RegExp][] = [
      ['prettier:check', /prettier/],
      ['lint', /\blint\b/],
      ['ts', /\bts\b|tsc/],
      ['test oder build', /\btest\b|\bbuild\b/],
    ];
    const absent = wanted.filter(([, re]) => !re.test(ci)).map(([n]) => n);
    if (absent.length) problems.push(`Script \`ci\` ohne ${missing(absent)}`);
  }
  const workflows = repo.workflowFiles();
  if (workflows.length === 0) problems.push('.github/workflows fehlt');
  else {
    // Der Required Check heißt `test` — nur was in diesem Job läuft, ist
    // durch den Branch-Schutz erzwungen.
    const blocks = workflows
      .map(file => testJobBlock(repo.read(file) ?? ''))
      .filter((block): block is string => block !== null);
    if (blocks.length === 0) problems.push('kein Workflow-Job `test`');
    else {
      if (!blocks.some(block => /pnpm run ci\b/.test(block)))
        problems.push('Job `test` führt `pnpm run ci` nicht aus');
      if (!blocks.some(block => /assurance(@\S+)?\s+check\b/.test(block)))
        problems.push('Job `test` führt `assurance check` nicht aus');
    }
  }
  return problems.length
    ? fail(problems.join('; ') + '.')
    : pass('Job `test`, `pnpm run ci` und `assurance check` vorhanden.');
};

const packageFloors: Check = repo => {
  const deps = allDependencies(repo.packageJson());
  const offenders: string[] = [];
  const checked: string[] = [];
  for (const [name, spec] of Object.entries(deps)) {
    const floor = PACKAGE_FLOORS[name];
    if (!floor || isWorkspaceSpec(spec)) continue;
    checked.push(name);
    const verdict = satisfiesFloor(spec, floor);
    // Tags, Git-Referenzen, Aliase und Bereiche mit Alternativen sind
    // keine prüfbare Untergrenze — das ist ein Verstoß, kein Freifahrtschein.
    if (verdict === null)
      offenders.push(
        `${name} „${spec}“ ist keine prüfbare Version (Floor ${floor})`,
      );
    else if (!verdict) offenders.push(`${name} ${spec} < ${floor}`);
  }
  if (offenders.length) return fail(`Unter Floor: ${missing(offenders)}.`);
  return pass(
    checked.length
      ? `${checked.length} @amadeni-Paket(e) auf oder über Floor.`
      : 'Kein @amadeni-Paket mit Floor in Verwendung.',
  );
};

const devContract: Check = repo => {
  const problems: string[] = [];
  if (!repo.exists('devcontract.config.json'))
    problems.push('devcontract.config.json fehlt');
  const deps = allDependencies(repo.packageJson());
  if (!deps['@amadeni/dev-contract'])
    problems.push('@amadeni/dev-contract ist keine Abhängigkeit');
  const justfile = repo.read('justfile') ?? repo.read('Justfile');
  if (justfile === null) problems.push('justfile fehlt');
  else if (
    !/^dev(-start)?:[^\n]*\n(?:[ \t]+[^\n]*\n?)*?[ \t]+[^\n]*dev-contract start/m.test(
      justfile,
    )
  )
    problems.push('kein just-Rezept `dev`, das `dev-contract start` ausführt');
  return problems.length
    ? fail(problems.join('; ') + '.')
    : pass('devcontract.config.json, Paket und just-Rezept vorhanden.');
};

const authKit: Check = repo => {
  const deps = allDependencies(repo.packageJson());
  if (!deps['@amadeni/better-auth-kit'])
    return fail('@amadeni/better-auth-kit ist keine Abhängigkeit.');
  const problems: string[] = [];
  // Aufruf UND Import aus dem Kit in derselben Datei; Kommentare zählen
  // nicht. Generische Aufrufe (`createDevAuth<ActionCtx>(`) zählen mit.
  if (
    grepFiles(repo, 'convex', [
      importsKit,
      /createAmadeniAuthOptions(<[^>]*>)?\(/,
    ]).length === 0
  )
    problems.push('convex/ nutzt createAmadeniAuthOptions aus dem Kit nicht');
  if (
    grepFiles(repo, 'convex', [importsKit, /createDevAuth(<[^>]*>)?\(/])
      .length === 0
  )
    problems.push(
      'Dev-Auth-Fixture createDevAuth aus dem Kit fehlt in convex/',
    );
  return problems.length
    ? fail(problems.join('; ') + '.')
    : pass('Auth-Optionen und Dev-Auth-Fixture kommen aus dem Kit.');
};

const loginMail: Check = repo => {
  const deps = allDependencies(repo.packageJson());
  if (!deps['@amadeni/better-auth-kit'])
    return fail('@amadeni/better-auth-kit ist keine Abhängigkeit.');
  const senders = grepFiles(repo, 'convex', [
    importsKit,
    /createResendMagicLinkSender\(/,
  ]);
  return senders.length
    ? pass(`Magic-Link-Mail aus dem Kit (${senders[0]}).`)
    : fail(
        'convex/ versendet die Login-Mail nicht über createResendMagicLinkSender aus dem Kit.',
      );
};

const e2eCliTest: Check = repo => {
  const problems: string[] = [];
  const pkg = repo.packageJson();
  if (!allDependencies(pkg)['@amadeni/convex-e2e'])
    problems.push('@amadeni/convex-e2e ist keine Abhängigkeit');
  if (repo.files('cli-test').length === 0)
    problems.push('Verzeichnis cli-test/ fehlt oder ist leer');
  const e2e = pkg?.scripts?.['test:e2e'] ?? '';
  if (!e2e) problems.push('Script `test:e2e` fehlt');
  else if (!/cli-test|convex-e2e/.test(e2e))
    problems.push('Script `test:e2e` ruft weder cli-test/ noch convex-e2e auf');
  return problems.length
    ? fail(problems.join('; ') + '.')
    : pass('cli-test/ mit Script `test:e2e` auf @amadeni/convex-e2e.');
};

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const purescriptCore: Check = repo => {
  const problems: string[] = [];
  if (!repo.exists('purescript/spago.yaml'))
    problems.push('purescript/spago.yaml fehlt');
  const bundles = repo.files('shared').filter(f => /\.gen\.mjs$/.test(f));
  if (bundles.length === 0)
    problems.push('kein generiertes Kern-Bundle (*.gen.mjs) unter shared/');
  else {
    // „An Convex“ heißt: Convex-Funktionen importieren das Bundle.
    const names = bundles.map(f =>
      f
        .split('/')
        .pop()!
        .replace(/\.mjs$/, ''),
    );
    const used = grepFiles(repo, 'convex', [
      new RegExp(
        `from\\s+['"][^'"]*(${names.map(escapeRegExp).join('|')})(\\.mjs)?['"]`,
      ),
    ]);
    if (used.length === 0)
      problems.push('convex/ importiert das generierte Kern-Bundle nicht');
  }
  const codegen = repo.packageJson()?.scripts?.['ps:codegen'] ?? '';
  if (!codegen) problems.push('Script `ps:codegen` fehlt');
  else if (!/spago|purs|ps-codegen|generate/.test(codegen))
    problems.push('Script `ps:codegen` sieht nicht nach Codegen aus');
  return problems.length
    ? fail(problems.join('; ') + '.')
    : pass(`PureScript-Kern mit generiertem Bundle (${bundles[0]}).`);
};

export const STATIC_CHECKS: Readonly<Record<string, Check>> = {
  'ci-gate': ciGate,
  'package-floors': packageFloors,
  'dev-contract': devContract,
  'auth-kit': authKit,
  'login-mail': loginMail,
  'e2e-cli-test': e2eCliTest,
  'purescript-core': purescriptCore,
};
