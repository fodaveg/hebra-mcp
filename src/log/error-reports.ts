/**
 * Errores a Bugsink (tarea de Lumbre 48e8e6f6, 27 nov 2026): hebra-mcp manda al proyecto `hebra`
 * sus excepciones no controladas, sus fallos internos y, como aviso, los errores de espacio y de
 * relé que dejan al agente sin servicio. Bugsink habla el protocolo de Sentry, así que se usa
 * `@sentry/node`, que se carga solo con el primer error: el arranque no paga el SDK.
 *
 * Lo que sale está cerrado igual que los logs (SPEC.md §6.4): `scrubEvent` rehace cada evento
 * desde cero con una lista blanca. Pasan el nivel, el código, el tipo de la excepción y su pila
 * (función, fichero sin directorios, línea), y las etiquetas `code`, `tool`, `version`, `mode` y
 * `kind` con valores de forma cerrada. No pasan nunca el mensaje de una excepción (puede citar
 * una nota, una ruta o un token), ni contenido o títulos de notas, rutas, nombres de espacio o de
 * carpeta, argumentos de herramienta, tokens, cabeceras, ids de cuenta, usuario, máquina,
 * contextos, extras ni migas.
 *
 * Apagado con `HEBRA_MCP_ERRORES=0`. Sin `configureErrorReports` (tests, comandos que no son
 * `serve` ni `serve-http`) no se manda nada.
 */
import type { ErrorEvent, NodeOptions } from '@sentry/node';

/** El proyecto `hebra` de Bugsink. Un DSN no es un secreto: solo deja mandar eventos. */
export const DEFAULT_ERRORS_DSN = 'https://fadd7c9f99e94f59b6942c7fd3843d3e@errores.dualhand.com/3';

/** Interruptor: `0` lo apaga. */
export const ERRORS_ENV = 'HEBRA_MCP_ERRORES';

/** Un mismo aviso (código y herramienta) sale como mucho una vez cada tanto por proceso. */
export const WARNING_INTERVAL_MS = 10 * 60_000;

/** `relay_unavailable` suelto es ruido de red: solo se avisa si se repite tantas veces en el
 *  intervalo de arriba. */
export const RELAY_UNAVAILABLE_REPEATS = 3;

/** Cuánto espera el apagado por un fallo fatal a que salga el evento. */
const FATAL_FLUSH_MS = 2000;

export type ErrorReportMode = 'stdio' | 'serve-http';

/** Los avisos de espacio y de relé que dejan al agente sin servicio. */
export type ServiceWarningCode =
  | 'space_quota_exceeded'
  | 'space_key_unreadable'
  | 'agent_revoked'
  | 'rate_limited'
  | 'relay_unavailable';

type Sdk = typeof import('@sentry/node');

interface Config {
  mode: ErrorReportMode;
  version: string;
  dsn: string;
  load: () => Promise<Sdk>;
  /** Solo los tests: el transporte que recibe los sobres, sin red. */
  transport?: NodeOptions['transport'];
}

let config: Config | null = null;
let sdk: Promise<Sdk | null> | null = null;
const lastWarning = new Map<string, number>();
const relayFailures: number[] = [];
let now: () => number = () => Date.now();

const ALLOWED_TAGS = ['code', 'tool', 'version', 'mode', 'kind'] as const;
/** Un valor de etiqueta: un código, un nombre de herramienta o una versión. */
const SAFE_TAG = /^[A-Za-z0-9_.:@+-]{1,80}$/u;
/** Un nombre de tipo o de función del código, nunca texto libre. */
const SAFE_NAME = /^[A-Za-z0-9_$.<>\[\] -]{1,120}$/u;
/** El mensaje de un aviso es su código, nada más. */
const SAFE_MESSAGE = /^[a-z0-9_]{1,64}$/u;

/**
 * Activa el envío para este proceso. `serve` lo llama con `stdio` y `serve-http` con su modo; un
 * `HEBRA_MCP_ERRORES=0` lo deja apagado. `options` es para los tests (cargador y transporte).
 */
export function configureErrorReports(
  context: { mode: ErrorReportMode; version: string },
  env: NodeJS.ProcessEnv = process.env,
  options: { load?: () => Promise<Sdk>; transport?: NodeOptions['transport']; now?: () => number } = {}
): boolean {
  resetErrorReports();
  if (env[ERRORS_ENV]?.trim() === '0') return false;
  config = {
    mode: context.mode,
    version: context.version,
    dsn: DEFAULT_ERRORS_DSN,
    load: options.load ?? (() => import('@sentry/node')),
    ...(options.transport ? { transport: options.transport } : {})
  };
  if (options.now) now = options.now;
  return true;
}

/** Vuelve al estado de antes de configurar (tests y reconfiguración). */
export function resetErrorReports(): void {
  config = null;
  sdk = null;
  lastWarning.clear();
  relayFailures.length = 0;
  now = () => Date.now();
}

/** ¿Hay envío activo? */
export function errorReportsEnabled(): boolean {
  return config !== null;
}

/** El SDK, cargado e iniciado la primera vez. `null` si no hay envío o si no se pudo cargar. */
function client(): Promise<Sdk | null> {
  const current = config;
  if (!current) return Promise.resolve(null);
  sdk ??= current
    .load()
    .then((Sentry) => {
      Sentry.init({
        dsn: current.dsn,
        release: `hebra-mcp@${current.version}`,
        environment: current.mode,
        // Ninguna integración por defecto: ni consola, ni http, ni contexto de la máquina, ni
        // variables locales, ni módulos. Solo lo que mandamos a mano.
        defaultIntegrations: false,
        integrations: [],
        enableRuntimeChannelInjection: false,
        // Nada de usuario, cookies, cabeceras, cuerpos ni parámetros, aunque una integración lo
        // pidiera; `scrubEvent` lo quitaría igual.
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
          urlQueryParams: false,
          graphQL: { document: false, variables: false },
          genAI: { inputs: false, outputs: false }
        },
        sendClientReports: false,
        serverName: 'hebra-mcp',
        maxBreadcrumbs: 0,
        beforeBreadcrumb: () => null,
        beforeSend: (event) => scrubEvent(event),
        beforeSendTransaction: () => null,
        ...(current.transport ? { transport: current.transport } : {})
      });
      return Sentry;
    })
    .catch(() => null);
  return sdk;
}

function baseTags(): Record<string, string> {
  return config ? { version: config.version, mode: config.mode } : {};
}

/** Una excepción no controlada o un fallo interno. Nunca lanza ni espera. */
export function reportException(error: unknown, tags: { code?: string; tool?: string; kind?: string } = {}): void {
  if (!config) return;
  void client()
    .then((Sentry) => {
      Sentry?.captureException(error instanceof Error ? error : new Error('non_error_thrown'), {
        level: 'error',
        tags: { ...baseTags(), ...tags }
      });
    })
    .catch(() => undefined);
}

/**
 * Un aviso de servicio (`ServiceWarningCode`), como mucho uno por código y herramienta cada
 * `WARNING_INTERVAL_MS`; `relay_unavailable`, solo si se repite `RELAY_UNAVAILABLE_REPEATS`
 * veces en ese intervalo. Nunca lanza ni espera.
 */
export function reportServiceWarning(code: ServiceWarningCode, tags: { tool?: string } = {}): void {
  if (!config) return;
  const at = now();
  if (code === 'relay_unavailable') {
    relayFailures.push(at);
    while (relayFailures.length > 0 && at - relayFailures[0]! > WARNING_INTERVAL_MS) relayFailures.shift();
    if (relayFailures.length < RELAY_UNAVAILABLE_REPEATS) return;
  }
  const key = `${code}:${tags.tool ?? ''}`;
  const last = lastWarning.get(key);
  if (last !== undefined && at - last < WARNING_INTERVAL_MS) return;
  lastWarning.set(key, at);
  void client()
    .then((Sentry) => {
      Sentry?.captureMessage(code, { level: 'warning', tags: { ...baseTags(), code, ...tags } });
    })
    .catch(() => undefined);
}

/** El código de error de una herramienta que avisa a Bugsink, con su motivo si lo trae. */
export function serviceWarningOf(code: string, extra?: Record<string, unknown>): ServiceWarningCode | null {
  if (code === 'space_quota_exceeded' || code === 'space_key_unreadable') return code;
  if (code === 'space_unavailable' || code === 'organizations_unavailable') {
    const reason = extra?.reason;
    if (reason === 'rate_limited' || reason === 'relay_unavailable') return reason;
    if (reason === 'credential_revoked') return 'agent_revoked';
  }
  return null;
}

/** Espera a que salga lo pendiente, como mucho `timeoutMs`. Nunca lanza. */
export async function flushErrorReports(timeoutMs = FATAL_FLUSH_MS): Promise<void> {
  if (!sdk) return;
  try {
    const Sentry = await sdk;
    await Sentry?.flush(timeoutMs);
  } catch {
    // Que no salga no cambia nada del proceso.
  }
}

/**
 * Las excepciones no controladas (también una promesa rechazada sin manejar, que Node convierte
 * en `uncaughtException`): se mandan, se espera a que salgan y el proceso termina con 1, como haría
 * Node, dejando en stderr el mismo JSON cerrado que el `fatal` de `main`. Sin envío activo no se
 * instala nada y Node hace lo de siempre.
 */
export function installCrashReports(): void {
  if (!config) return;
  process.on('uncaughtException', (error, origin) => {
    const name = error instanceof Error ? error.name : 'unknown';
    process.stderr.write(`${JSON.stringify({ event: 'fatal', error: name, origin })}\n`);
    reportException(error, { kind: origin });
    void flushErrorReports().finally(() => process.exit(1));
  });
}

function safeName(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_NAME.test(value) ? value : undefined;
}

/** Solo el nombre del fichero: ni directorios (la ruta de instalación lleva el usuario) ni `file://`. */
function baseName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.split(/[\\/]/u).pop();
  return name && SAFE_NAME.test(name) ? name : undefined;
}

/**
 * El evento rehecho con la lista blanca de arriba. Lo que no está en ella no sale, venga de donde
 * venga (el SDK, una integración o quien llama).
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const tags: Record<string, string> = {};
  for (const key of ALLOWED_TAGS) {
    const value = event.tags?.[key];
    if (typeof value === 'string' && SAFE_TAG.test(value)) tags[key] = value;
  }
  const values = (event.exception?.values ?? []).map((exception) => ({
    ...(safeName(exception.type) ? { type: safeName(exception.type) } : {}),
    ...(exception.mechanism
      ? { mechanism: { type: safeName(exception.mechanism.type) ?? 'generic', handled: exception.mechanism.handled === true } }
      : {}),
    ...(exception.stacktrace?.frames
      ? {
          stacktrace: {
            frames: exception.stacktrace.frames.map((frame) => ({
              ...(safeName(frame.function) ? { function: safeName(frame.function) } : {}),
              ...(baseName(frame.filename) ? { filename: baseName(frame.filename) } : {}),
              ...(typeof frame.lineno === 'number' ? { lineno: frame.lineno } : {}),
              ...(typeof frame.colno === 'number' ? { colno: frame.colno } : {}),
              ...(typeof frame.in_app === 'boolean' ? { in_app: frame.in_app } : {})
            }))
          }
        }
      : {})
  }));
  const message = typeof event.message === 'string' && SAFE_MESSAGE.test(event.message) ? event.message : undefined;
  return {
    type: undefined,
    ...(event.event_id ? { event_id: event.event_id } : {}),
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
    platform: 'node',
    ...(event.level ? { level: event.level } : {}),
    ...(event.release ? { release: event.release } : {}),
    ...(event.environment ? { environment: event.environment } : {}),
    ...(event.sdk ? { sdk: { name: event.sdk.name, version: event.sdk.version } } : {}),
    ...(message ? { message } : {}),
    tags,
    ...(values.length > 0 ? { exception: { values } } : {})
  };
}
