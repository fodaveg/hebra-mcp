import type { AdmissionTicket } from '../accounts/capacity';
import type { Clock } from '../accounts/lifecycle';
import type { HebraLibraryPort } from '../store/types';
import type { PrivacyFilter } from '../privacy/filter';
import type { PrivacyConfig } from '../privacy/config';
import { privacyWithMemory } from '../privacy/folder-memory';
import type { StatusSource } from '../status/status-source';
import type { AgentDirectory } from '../spaces/protocol';
import { GateUsage } from './privacy-gate';
import type { WriteContext } from './write-context';

/**
 * Lo que vive todo el proceso: el almacén, la CONFIGURACIÓN de privados (no el filtro ya
 * construido), la fuente de estado y, si el proceso puede escribir (L3b), el
 * `WriteContext`. El filtro NO se guarda aquí a propósito: el sync cambia el almacén
 * mientras el proceso vive (`SyncRunner`, `src/sync/`), así que un `PrivacyFilter`
 * cacheado se queda obsoleto y puede enseñar, o esconder, una nota que ya no es así
 * (hallazgo del coordinador, 26 sep 2026 — antes de esto, `main.ts` construía el filtro
 * UNA vez al arrancar).
 *
 * `write` es opcional para no romper los tests de L1 que construyen un `ServerContext`
 * sin él (solo lectura): `hebra_create_note`/`hebra_append_to_note` son las únicas
 * herramientas que lo necesitan.
 */
export interface SpaceRouter {
  list(): Promise<Array<{ spaceId: string; name: string | null }>>;
  /** Abre el espacio y lo retiene hasta cerrar el router: el uso por stdio. */
  resolve(spaceId: string): Promise<ServerContext>;
  /** `serve-http`: cada uso se adquiere y se suelta, y el espacio se cierra cuando termina. */
  lifecycle?: SpaceLifecycleControl;
}

export interface SpaceLease {
  value: ServerContext;
  release(): void;
}

/** Lo que `AccountContexts` necesita de los espacios de una cuenta (SPEC.md §12.10, D22). */
export interface SpaceLifecycleControl {
  /** Antes del primer uso: activa el cierre por inactividad y la admisión por memoria. */
  configure(options: {
    idleMs: number;
    /** Plazo de espera de una apertura (`HEBRA_MCP_OPEN_WAIT_MS`); sin él, el valor por defecto. */
    openWaitMs?: number;
    clock: Clock;
    admit(signal: AbortSignal): Promise<AdmissionTicket>;
    onClosed(): void;
  }): void;
  acquire(spaceId: string): Promise<SpaceLease>;
  /** Como `acquire` para varios espacios, con un solo catálogo para el lote y sin red los que ya
   *  están abiertos. Un espacio que no se abre (ajeno, apagado, con error) falta del resultado:
   *  que lo diga la herramienta. Solo rechaza una apertura sin capacidad. `shouldStop` corta el
   *  lote, p. ej. si el cliente ya se fue. */
  prepare(spaceIds: readonly string[], shouldStop?: () => boolean): Promise<SpaceLease[]>;
  /** Cierra ya los espacios sin peticiones en curso ni subidas pendientes. */
  reclaimIdle(): Promise<void>;
  beginShutdown(): void;
}

/** Lo que devuelve el relé, y qué miembro es la persona (el `accountId` de su registro). */
export interface DirectoryView {
  selfAccountId: string;
  directory: AgentDirectory;
}

export interface ServerContext {
  spaces?: SpaceRouter;
  /** `serve-http`: la petición dura hasta que acabe esta llamada, aunque el cliente se vaya. */
  trackInvocation?<T>(run: () => Promise<T>): Promise<T>;
  /** El directorio de la persona (D22), fresco. Falla con `organizations_unavailable`. */
  directory?: () => Promise<DirectoryView>;
  spaceId?: string;
  /** Nombre del espacio compartido (cacheado; `null` si no se pudo leer). Contenido del usuario: nunca a logs. */
  spaceName?: () => string | null;
  authorize?(): Promise<void>;
  port: HebraLibraryPort;
  /** La configuración de privados; con `privacyConfigSource`, la del arranque. */
  privacyConfig: PrivacyConfig;
  /** `serve` (M5 del audit de privacidad, 11 oct 2026): `config.json` releído cuando
   *  cambia, en cada llamada (`src/privacy/config-source.ts`). Sin él (tests, ficheros de
   *  trabajo), `privacyConfig` tal cual. */
  privacyConfigSource?: {
    current(): Promise<PrivacyConfig>;
    /** Síncrono: ¿sigue el fichero siendo el de la configuración instalada? (la puerta final
     *  lo mira dentro de su transacción). */
    isInstalledNow?(): boolean;
  };
  status: StatusSource;
  write?: WriteContext;
  /** Biblioteca personal (§8, §12.10): resuelve al terminar la primera ronda, o a los 10 s de
   *  abrir, y nunca rechaza. Los espacios no lo llevan: su apertura ya espera esa ronda. */
  firstRound?: () => Promise<void>;
}

/** Todo lo que una herramienta necesita PARA ESTA llamada: el almacén, un filtro de
 *  privados recién calculado del almacén (§6.3), la fuente de estado (§5,
 *  `hebra_status`) y, si aplica, el `WriteContext` (L3b). `register-tools.ts` construye
 *  uno por llamada con `resolveToolContext`; ninguna herramienta guarda esto entre
 *  llamadas.
 *
 *  `privacyConfig` (la configuración, no el filtro) viaja con las escrituras de la
 *  edición y la organización: el escritor la vuelve a aplicar DENTRO del turno en que
 *  escribe (D2 ampliada), también cuando se la reenvía un lector. */
export interface ToolContext {
  port: HebraLibraryPort;
  privacy: PrivacyFilter;
  privacyConfig: PrivacyConfig;
  status: StatusSource;
  write?: WriteContext;
  /** Lo que usa la respuesta, para la puerta final (`./privacy-gate.ts`): uno por intento.
   *  Opcional para los tests que llaman a una herramienta directamente, sin puerta. */
  usage?: GateUsage;
  /** La época de privacidad del almacén al empezar la llamada, antes de su filtro
   *  (`HebraLibraryPort.privacyEpoch`): la que compara la puerta final. */
  epoch?: string;
  /** Lo que solo debe pasar si la puerta acepta ESTE intento (un log que no puede salir una
   *  vez por intento repetido). Sin puerta, se hace en el acto (`afterGate`). */
  deferred?: Array<() => void>;
}

/** `ctx.usage`, o uno suelto que nadie comprueba (una herramienta llamada sin puerta). */
export function usageOf(ctx: ToolContext): GateUsage {
  ctx.usage ??= new GateUsage(ctx.privacy);
  return ctx.usage;
}

/** `run` cuando la puerta final acepte este intento; sin puerta, ya. */
export function afterGate(ctx: ToolContext, run: () => void): void {
  if (ctx.deferred) ctx.deferred.push(run);
  else run();
}

/** `PrivacyFilter.build` es dos consultas al almacén (`foldersList()` +
 *  `notesVisibilityIndex()`, ambas O(1) ronda): barato de sobra para pagarlo en cada
 *  llamada de herramienta en vez de cachearlo. Antes, la configuración vigente (M5: un
 *  `stat` de `config.json`; si no se puede aplicar, `PrivacyConfigUnreadable`) y la memoria
 *  de las carpetas privadas (A3, `privacyWithMemory`: una lectura más, y una escritura solo
 *  cuando una ruta resuelve a una carpeta nueva). La `privacyConfig` que sale lleva esa
 *  memoria (`knownPrivateFolderIds`), y con ella viaja a las escrituras. */
export async function resolveToolContext(ctx: ServerContext): Promise<ToolContext> {
  const current = ctx.privacyConfigSource ? await ctx.privacyConfigSource.current() : ctx.privacyConfig;
  // La época de privacidad ANTES del filtro (`./privacy-gate.ts`): cualquier cambio desde aquí,
  // también mientras se construye, hace que la puerta final no pase. Si anotar la memoria de
  // carpetas privadas (A3) la cambia, se toma otra vez: lo que anota esta misma llamada no
  // cuenta como un cambio de otro (la segunda vez ya no anota nada).
  let epoch = await ctx.port.privacyEpoch();
  let resolved = await privacyWithMemory(ctx.port, current);
  if (resolved.remembered) {
    epoch = await ctx.port.privacyEpoch();
    resolved = await privacyWithMemory(ctx.port, current);
  }
  const { config, filter } = resolved;
  return {
    port: ctx.port,
    privacy: filter,
    privacyConfig: config,
    status: ctx.status,
    write: ctx.write,
    usage: new GateUsage(filter),
    epoch
  };
}
