# @amadeni/assurance

Der Assurance-Katalog der Amadeni-Flotte: welche Features jedes Kundenprojekt
in welcher Stufe zusichert — als Code mit Prüfung, Abhilfe und einem Report,
den FlightControl und mynd lesen. Kein Prosa-Dokument, das Echo pro Repo neu
interpretiert.

```
assurance check --github          # im CI (Job `test`): prüfen + Check-Run `assurance`
assurance check --no-exec         # lokal (`just assurance`): ohne Dev-Start
assurance check --level standard  # Vorschau ohne assurance.json (Flotten-Erhebung)
assurance init --level basis      # legt assurance.json an
assurance catalog                 # zeigt den Katalog mit Zusagen
```

## Das Modell

Ein Projekt deklariert in `assurance.json`, welche Stufe es zusichert. Der
Katalog sagt pro Feature, was das bedeutet (Zusage), warum es gilt (Warum),
wo die Referenz liegt und wie ein Projekt hinkommt (Abhilfe). Die Prüfung
läuft im CI des Projekts, als Schritt im Required Check `test` — ein grüner
`test` auf main ist der Beleg, und ein PR, der die Zusicherung bricht, wird
rot, bevor er mergen kann.

| Stufe      | verlangt zusätzlich                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `basis`    | CI-Gate, Repo-Schutzstandard, Paket-Mindestversionen                                                |
| `standard` | Dev-Backend per just (dev-contract), Auth + Login-Mail aus dem Kit, Login demonstrierbar, E2E-Tests |
| `voll`     | PureScript-Kern an Convex, geteilte UI-Komponenten (geplant)                                        |

Jedes Feature hat eine **Klasse** und einen **Prüfer**:

| Klasse        | Zusicherung                                        | Beispiele                             |
| ------------- | -------------------------------------------------- | ------------------------------------- |
| `package`     | Code lebt einmal im Paket, Projekt ≥ Floor-Version | Auth-Flow, Login-Mail, Paket-Floors   |
| `structure`   | Datei, Script oder Job ist vorhanden               | CI-Gate, dev-contract, Repo-Standard  |
| `conformance` | eine Form, die ausgeführt geprüft wird             | Login demonstrierbar, E2E, PureScript |

| Prüfer  | wer prüft                                                               |
| ------- | ----------------------------------------------------------------------- |
| `local` | diese CLI, statisch (Dateien, package.json, Workflow)                   |
| `exec`  | diese CLI führt das Projekt aus: `dev-contract start` muss ready melden |
| `fleet` | FlightControl von außen (Repo-Ruleset) — im Report als `fleet` sichtbar |

Ein Feature, das in keine Klasse passt, ist nicht prüfbar und gehört nicht
in den Katalog.

## `assurance.json`

```json
{
  "catalogVersion": 1,
  "level": "standard",
  "waived": [
    {
      "feature": "e2e-cli-test",
      "reason": "reine Landingpage ohne Backend",
      "until": "2026-12-31"
    }
  ]
}
```

Eine Ausnahme braucht einen Grund; mit `until` läuft sie ab, danach fällt das
Feature wieder durch. Ausnahmen liegen im Repo und gehen durch die PR-Review
wie jede andere Änderung — es gibt keinen Override-Layer in einer Datenbank.

## Im CI

```yaml
jobs:
  test:
    permissions:
      contents: read
      checks: write # der Report wird als Check-Run `assurance` angelegt
    steps:
      # … checkout, node, pnpm install …
      - run: pnpm run ci
      - name: Assurance
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.GH_PACKAGES_READ }}
        run: |
          printf '@amadeni:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$NODE_AUTH_TOKEN" > "$RUNNER_TEMP/assurance.npmrc"
          NPM_CONFIG_USERCONFIG="$RUNNER_TEMP/assurance.npmrc" pnpm dlx @amadeni/assurance@0.1.0 check --github
```

Das Paket ist privat auf GitHub Packages. Gelesen wird mit einem Token
`read:packages`: im CI das Org-Secret `GH_PACKAGES_READ` (einmal für alle
Repos gesetzt), lokal der gh-Login (`gh auth token`) — Org-Mitglieder
brauchen kein weiteres Secret. Registry und Token gelten nur für diesen
Aufruf (`NPM_CONFIG_USERCONFIG`), nicht für das Projekt; die Templates
bringen dafür `scripts/assurance.sh` und `just assurance` mit.

Die Version ist exakt gepinnt: ein Katalog-Release ist ein bewusster Bump im
Projekt, keine Überraschung im nächsten CI-Lauf. Fork-PRs haben keinen
Schreib-Token; dort wird der Check-Run übersprungen und gemeldet, das
Ergebnis (Exit-Code) gilt trotzdem.

`--no-exec` gehört **nicht** in den CI-Schritt: es überspringt die
ausgeführten Prüfungen und markiert sie als `skipped` — FlightControl wertet
das als Verstoß, weil der Nachweis fehlt. Lokal ist `--no-exec` der schnelle
Blick (`just assurance`).

## Der Report (Vertrag 1)

Der Check-Run `assurance` trägt im Text einen JSON-Block. FlightControl und
mynd lesen ihn und brauchen keine Kopie des Katalogs:

```json
{
  "contract": 1,
  "package": "@amadeni/assurance@0.1.0",
  "catalogVersion": 1,
  "declaredLevel": "standard",
  "level": "standard",
  "ok": false,
  "executed": true,
  "results": [
    {
      "feature": "dev-contract",
      "title": "Dev-Backend per just",
      "class": "structure",
      "level": "standard",
      "verifier": "local",
      "status": "fail",
      "detail": "devcontract.config.json fehlt."
    }
  ],
  "catalog": [
    {
      "id": "dev-contract",
      "title": "Dev-Backend per just",
      "class": "structure",
      "level": "standard",
      "verifier": "local",
      "maturity": "active",
      "promise": "…",
      "rationale": "…",
      "reference": "…",
      "remedy": "…"
    }
  ]
}
```

Status je Feature: `pass` · `fail` · `waived` · `fleet` (prüft
FlightControl) · `planned` (im Katalog, noch nicht prüfbar) ·
`not-required` (höhere Stufe) · `skipped` (ausgeführte Prüfung mit
`--no-exec` übersprungen). `ok` heißt: kein `fail`. Exit-Code 1 bei
mindestens einem `fail`, 2 bei kaputtem Manifest oder Aufruf.

Derselbe Report kommt mit `--json` als letzte stdout-Zeile und mit
`--out datei` in eine Datei. `extractReport(text)` aus diesem Paket liest ihn
aus einem Check-Run-Text zurück; Konsumenten, die das Paket nicht einbinden,
halten sich an dieselbe Regel: JSON-Block im Text, `contract === 1`, sonst
kein Report.

## Wer macht was

- **Projekt-CI** prüft und veröffentlicht den Report — jeder Push, jeder PR.
- **FlightControl** hält das Soll (`projects.assuranceLevel`), liest
  `assurance.json`, den Check `test` und den Check-Run `assurance` vom
  Default-Branch und urteilt im Kern: Manifest fehlt, Stufe unter Soll, Gate
  rot, Feature durchgefallen, Nachweis übersprungen, Ausnahme abgelaufen.
  `projectAssure` übergibt Soll und Befunde an mynd.
- **mynd** zeigt die Matrix Projekte × Features aus denselben Reports
  (`/dev/assurance`) und macht aus einem Befund einen regulären Dev-Job mit
  der Abhilfe aus dem Katalog; der PR geht wie jeder andere über den
  Repo-Standard nach main.

## Katalog pflegen

- **Neues Feature:** Eintrag in `src/catalog.ts` (Klasse, Stufe, Prüfer,
  Zusage, Warum, Referenz, Abhilfe) und — bei `local`/`exec` und `active` —
  eine Prüfung in `src/checks.ts` bzw. `src/exec.ts`. Der Test hält beide
  Listen deckungsgleich.
- **Höherer Floor:** `PACKAGE_FLOORS` anheben. Das ist ein Katalog-Release
  und hebt die Anforderung flottenweit; Consumer-CIs werden rot, sobald sie
  die neue Version pinnen.
- **Bruch des Manifest-Formats:** `CATALOG_VERSION` erhöhen; ältere Manifeste
  bleiben lesbar, neuere werden laut abgelehnt.
- **Bruch des Report-Formats:** `REPORT_CONTRACT` erhöhen und FlightControl
  und mynd nachziehen — bis dahin lesen sie den neuen Report als „keiner“.
- **Release:** `pnpm release` (patch) bzw. `release:minor` taggt und pusht;
  der Workflow veröffentlicht privat auf GitHub Packages mit dem
  Workflow-Token des Repos — kein npm-Konto, kein Secret. Die erste Version
  0.1.0 bekommt ihren Tag von Hand (`git tag v0.1.0 main && git push origin
v0.1.0`), weil `pnpm release` sonst auf 0.1.1 hebt.

## Entwicklung

```
pnpm install
pnpm run ci      # prettier, lint, types, spelling, tests, build
node dist/bin.js check --root ../eberswalder-zeitreise --no-exec
```
