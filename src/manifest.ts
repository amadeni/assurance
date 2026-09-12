// `assurance.json` im Repo-Root: die Selbstauskunft des Projekts — welche
// Stufe es zusichert und welche Features es bewusst ausnimmt. Ohne
// Ausnahmen-Mechanik kämpft Echo gegen Sonderfälle; mit Grund und Frist
// bleibt jede Ausnahme sichtbar und endlich.

import {
  CATALOG_VERSION,
  featureById,
  isLevel,
  type Level,
} from './catalog.js';

export const MANIFEST_FILE = 'assurance.json';

export type Waiver = {
  feature: string;
  reason: string;
  /** ISO-Datum (YYYY-MM-DD); danach gilt die Ausnahme nicht mehr. */
  until?: string;
};

export type Manifest = {
  catalogVersion: number;
  level: Level;
  waived: Waiver[];
};

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD und ein echtes Kalenderdatum (2026-99-99 fällt durch). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function parseManifest(text: string): ParseResult<Manifest> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: `${MANIFEST_FILE} ist kein gültiges JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return parseManifestValue(json);
}

export function parseManifestValue(json: unknown): ParseResult<Manifest> {
  if (!isRecord(json)) {
    return { ok: false, error: `${MANIFEST_FILE} muss ein Objekt sein.` };
  }
  const catalogVersion = json.catalogVersion;
  if (typeof catalogVersion !== 'number' || !Number.isInteger(catalogVersion)) {
    return { ok: false, error: 'catalogVersion muss eine ganze Zahl sein.' };
  }
  if (catalogVersion > CATALOG_VERSION) {
    return {
      ok: false,
      error: `catalogVersion ${catalogVersion} ist neuer als dieses Paket (Katalog ${CATALOG_VERSION}) — @amadeni/assurance aktualisieren.`,
    };
  }
  if (!isLevel(json.level)) {
    return {
      ok: false,
      error: 'level muss basis, standard oder voll sein.',
    };
  }
  const waivedRaw = json.waived ?? [];
  if (!Array.isArray(waivedRaw)) {
    return { ok: false, error: 'waived muss eine Liste sein.' };
  }
  const waived: Waiver[] = [];
  for (const entry of waivedRaw) {
    if (!isRecord(entry) || typeof entry.feature !== 'string') {
      return {
        ok: false,
        error: 'Jede Ausnahme braucht ein Feld feature.',
      };
    }
    if (!featureById(entry.feature)) {
      return {
        ok: false,
        error: `Ausnahme für unbekanntes Feature „${entry.feature}“.`,
      };
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      return {
        ok: false,
        error: `Ausnahme für „${entry.feature}“ braucht einen Grund (reason).`,
      };
    }
    if (entry.until !== undefined) {
      if (typeof entry.until !== 'string' || !isIsoDate(entry.until)) {
        return {
          ok: false,
          error: `Ausnahme für „${entry.feature}“: until muss YYYY-MM-DD sein.`,
        };
      }
    }
    waived.push({
      feature: entry.feature,
      reason: entry.reason.trim(),
      ...(typeof entry.until === 'string' ? { until: entry.until } : {}),
    });
  }
  return { ok: true, value: { catalogVersion, level: json.level, waived } };
}

/** Die Ausnahme, die heute für ein Feature gilt — abgelaufene zählen nicht. */
export function activeWaiver(
  manifest: Manifest,
  featureId: string,
  today: string,
): Waiver | undefined {
  return manifest.waived.find(
    waiver =>
      waiver.feature === featureId &&
      (waiver.until === undefined || waiver.until >= today),
  );
}

export function renderManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
