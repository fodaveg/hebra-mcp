/**
 * La configuración de privados de UNA llamada con la memoria de las carpetas privadas (A3
 * del audit de privacidad adversarial, 10 oct 2026; SPEC.md §6.3, D16).
 *
 * `privateFolders` son rutas, y una ruta se resuelve a carpetas con el almacén de cada
 * momento. Si la carpeta privada se mueve dentro de otra y se crea una nueva con su nombre,
 * la ruta pasa a nombrar la nueva y la vieja quedaba visible. Por eso se recuerda a qué
 * carpetas resolvió cada ruta (`hebra_mcp_private_folders`, `src/store/private-folders.ts`) y
 * el filtro oculta la unión: las de ahora y las recordadas de las rutas que SIGUEN
 * configuradas (`PrivacyConfig.knownPrivateFolderIds`).
 *
 * Se llama en cada llamada de herramienta (`resolveToolContext`), al abrir los ficheros de
 * trabajo (`src/workdir/library.ts`) y, en el escritor, antes de cada ronda de sync
 * (`beforeSyncRound` de `serve`): así una ronda que trae la carpeta movida encuentra
 * anotada la de antes aunque nadie haya llamado a una herramienta entre medias.
 *
 * Lo que queda fuera: una ruta que nunca se resolvió con esa configuración (configurada con
 * el proceso parado y movida antes de la primera ronda) no tiene nada que recordar; la ruta
 * de ahora nombra la que el usuario ve hoy con ese nombre.
 */
import type { HebraLibraryPort, RememberedPrivateFolder } from '../store/types';
import type { PrivacyConfig } from './config';
import { PrivacyFilter } from './filter';
import { privacyPathKey } from './folder-index';

/**
 * `config` con `knownPrivateFolderIds`: las carpetas recordadas de las rutas que SIGUEN
 * configuradas (las de una ruta que ya no está, fuera). Sin escribir nada: lo usa también la
 * puerta final (`src/server/privacy-gate.ts`) con la memoria leída en su transacción.
 */
export function withRememberedFolders(
  config: PrivacyConfig,
  remembered: readonly RememberedPrivateFolder[]
): PrivacyConfig {
  const keys = new Set(config.privateFolders.map((segments) => privacyPathKey(segments)));
  const known = new Set<string>();
  for (const entry of remembered) {
    if (keys.has(entry.pathKey)) known.add(entry.folderId);
  }
  const { knownPrivateFolderIds: _ignored, ...base } = config;
  return known.size > 0 ? { ...base, knownPrivateFolderIds: [...known].sort() } : base;
}

/** Lo que necesita del almacén: el filtro y la memoria. */
export type PrivacyMemoryPort = Pick<
  HebraLibraryPort,
  'foldersList' | 'notesVisibilityIndex' | 'rememberedPrivateFolders' | 'rememberPrivateFolders'
>;

/**
 * La configuración con `knownPrivateFolderIds` y el filtro construido con ella. Anota las
 * carpetas que la configuración resuelve ahora y no estaban, y olvida las de las rutas que
 * ya no están configuradas (en la tabla, solo si este proceso es el escritor).
 */
export async function privacyWithMemory(
  port: PrivacyMemoryPort,
  config: PrivacyConfig
): Promise<{ config: PrivacyConfig; filter: PrivacyFilter; remembered: boolean }> {
  const configured = [...new Set(config.privateFolders.map((segments) => privacyPathKey(segments)))];
  const remembered = await port.rememberedPrivateFolders();
  const seen = new Set<string>();
  const keys = new Set(configured);
  let stale = false;
  for (const entry of remembered) {
    seen.add(`${entry.pathKey}\u0000${entry.folderId}`);
    if (!keys.has(entry.pathKey)) stale = true;
  }
  const withMemory = withRememberedFolders(config, remembered);
  const known = new Set(withMemory.knownPrivateFolderIds ?? []);
  const { knownPrivateFolderIds: _ignored, ...base } = config;
  const filter = await PrivacyFilter.build(port, withMemory);
  const fresh = filter
    .resolvedPrivateFolders()
    .filter((entry) => !seen.has(`${entry.pathKey}\u0000${entry.folderId}`));
  // `remembered`: si anotó u olvidó algo (cambia la época de privacidad de la puerta final).
  const wrote = fresh.length > 0 || stale;
  if (wrote) await port.rememberPrivateFolders(fresh, configured);
  if (fresh.length === 0) return { config: withMemory, filter, remembered: wrote };
  // Lo de ahora también viaja con la configuración (al escritor, si esta llamada escribe).
  for (const entry of fresh) known.add(entry.folderId);
  return { config: { ...base, knownPrivateFolderIds: [...known].sort() }, filter, remembered: wrote };
}
