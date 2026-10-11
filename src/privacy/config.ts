/**
 * `config.json` del filtro de privados (SPEC.md §6.3): `privateFolders` (rutas, en
 * minúsculas como las guarda el almacén) y `privateTags` (etiquetas, cualquier forma
 * escrita: se canonicalizan con `canonicalTag` al cargar). No viaja por sync; vive solo
 * en el directorio de datos de este proceso.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalTag } from '../hebra';

export interface PrivacyConfig {
  /** Rutas de carpeta, cada segmento en minúsculas (`diario`, `salud/médico`). */
  privateFolders: string[][];
  /** Etiquetas ya canonicalizadas (`canonicalTag`); las que no canonicalizan a nada
   *  (vacías tras normalizar) se ignoran. */
  privateTags: string[];
  /**
   * No sale de `config.json`: lo añade `privacyWithMemory` (`./folder-memory.ts`) en cada
   * llamada. Carpetas a las que resolvió antes alguna ruta de `privateFolders` todavía
   * configurada (A3 del audit de privacidad, 10 oct 2026): el filtro las oculta, con su
   * subárbol, aunque la ruta nombre hoy otra carpeta. Viaja con la configuración hasta el
   * escritor (que la aplica en su turno) y no cuenta para la huella de un plan de
   * `hebra_replace_in_notes` (`privacyFingerprint`), que solo mira las dos listas de arriba.
   */
  knownPrivateFolderIds?: string[];
}

const EMPTY_CONFIG: PrivacyConfig = { privateFolders: [], privateTags: [] };

interface RawConfig {
  privateFolders?: unknown;
  privateTags?: unknown;
}

function parseFolderPath(raw: string): string[] {
  return raw
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0);
}

/** Sin `config.json`: ninguna carpeta ni etiqueta privada (biblioteca entera visible). */
export async function loadPrivacyConfig(dataDir: string): Promise<PrivacyConfig> {
  const path = join(dataDir, 'config.json');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_CONFIG;
    throw error;
  }
  return parsePrivacyConfig(text);
}

/** El texto de `config.json` ya leído. Lanza si no es JSON. */
export function parsePrivacyConfig(text: string): PrivacyConfig {
  const raw = JSON.parse(text) as RawConfig;
  const privateFolders = Array.isArray(raw.privateFolders)
    ? raw.privateFolders.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const privateTags = Array.isArray(raw.privateTags)
    ? raw.privateTags.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    privateFolders: privateFolders.map(parseFolderPath).filter((segments) => segments.length > 0),
    privateTags: [
      ...new Set(
        privateTags
          .map((tag) => canonicalTag(tag)?.tag)
          .filter((tag): tag is string => Boolean(tag))
      )
    ]
  };
}
