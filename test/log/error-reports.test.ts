/**
 * Errores a Bugsink (`src/log/error-reports.ts`): el SDK se carga solo con el primer error,
 * `HEBRA_MCP_ERRORES=0` lo apaga y ningún evento lleva datos sensibles aunque el SDK o quien
 * llama los pongan. Sin red: un transporte que guarda los sobres.
 */
import * as Sentry from '@sentry/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureErrorReports,
  DEFAULT_ERRORS_DSN,
  flushErrorReports,
  RELAY_UNAVAILABLE_REPEATS,
  reportException,
  reportServiceWarning,
  resetErrorReports,
  scrubEvent,
  serviceWarningOf,
  WARNING_INTERVAL_MS
} from '../../src/log/error-reports';

/** Un transporte que guarda el texto de cada sobre. */
function capture() {
  const bodies: string[] = [];
  const transport = (options: Parameters<typeof Sentry.createTransport>[0]) =>
    Sentry.createTransport(options, async (request) => {
      bodies.push(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body));
      return { statusCode: 200 };
    });
  /** Los eventos (no las cabeceras de sobre ni de ítem). */
  const events = (): Array<Record<string, unknown>> =>
    bodies.flatMap((body) =>
      body
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((item) => 'level' in item || 'exception' in item || 'message' in item)
    );
  return { bodies, transport, events };
}

const SENSITIVE = [
  '# Acta secreta de la reunión',
  'Título privado de la nota',
  '/Users/david/Library/Application Support/hebra-mcp',
  '20-29 productos/22 proyectos',
  'Dualhand secreto',
  'tok_readToken_ABCDEF123456',
  'Bearer eyJhbGciOi',
  'cuenta-sin-hash-1234',
  'mi-portatil.local'
];

afterEach(() => {
  resetErrorReports();
  vi.restoreAllMocks();
});

describe('carga y apagado', () => {
  it('el SDK no se carga hasta el primer error', async () => {
    const load = vi.fn(async () => Sentry);
    const { transport } = capture();
    configureErrorReports({ mode: 'stdio', version: '0.4.0' }, {}, { load, transport });
    expect(load).not.toHaveBeenCalled();
    reportException(new Error('x'));
    await flushErrorReports(1000);
    expect(load).toHaveBeenCalledTimes(1);
    reportServiceWarning('space_quota_exceeded');
    await flushErrorReports(1000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('HEBRA_MCP_ERRORES=0: ni se carga ni se manda nada', async () => {
    const load = vi.fn(async () => Sentry);
    expect(configureErrorReports({ mode: 'stdio', version: '0.4.0' }, { HEBRA_MCP_ERRORES: '0' }, { load })).toBe(false);
    reportException(new Error('x'));
    reportServiceWarning('space_quota_exceeded');
    await flushErrorReports(100);
    expect(load).not.toHaveBeenCalled();
  });

  it('sin configurar (tests, otros comandos) no se manda nada', async () => {
    reportException(new Error('x'));
    await flushErrorReports(100);
  });

  it('el DSN por defecto es el del proyecto hebra de Bugsink', () => {
    expect(DEFAULT_ERRORS_DSN).toBe('https://fadd7c9f99e94f59b6942c7fd3843d3e@errores.dualhand.com/3');
  });
});

describe('ningún dato sensible sale', () => {
  it('un evento lleno de datos sensibles sale solo con código, tipo, pila y etiquetas cerradas', async () => {
    const sink = capture();
    configureErrorReports({ mode: 'serve-http', version: '0.4.0' }, {}, { load: async () => Sentry, transport: sink.transport });
    // Primero se inicia el SDK (el primer error) y después se le llena el ámbito de basura.
    reportServiceWarning('space_key_unreadable', { tool: 'hebra_read_note' });
    await flushErrorReports(1000);
    Sentry.setUser({ id: SENSITIVE[7], email: 'david@example.com', ip_address: '10.0.0.1' });
    Sentry.setExtra('body', SENSITIVE[0]);
    Sentry.setExtra('args', { title: SENSITIVE[1], folder: SENSITIVE[3] });
    Sentry.setTag('note', SENSITIVE[1]);
    Sentry.setTag('space', SENSITIVE[4]);
    Sentry.setContext('request', { headers: { authorization: SENSITIVE[6] } });
    Sentry.addBreadcrumb({ message: SENSITIVE[0] });
    const error = new Error(`ENOENT ${SENSITIVE[2]} ${SENSITIVE[0]} ${SENSITIVE[5]}`);
    reportException(error, { tool: 'hebra_create_note', kind: 'internal', code: SENSITIVE[3] });
    await flushErrorReports(1000);

    const text = sink.bodies.join('\n');
    for (const value of SENSITIVE) expect(text).not.toContain(value);
    expect(text).not.toContain('david@example.com');
    expect(text).not.toContain('10.0.0.1');
    expect(text).not.toContain('/Users/');

    const [warning, exception] = sink.events();
    expect(warning).toMatchObject({
      level: 'warning',
      message: 'space_key_unreadable',
      release: 'hebra-mcp@0.4.0',
      environment: 'serve-http',
      tags: { code: 'space_key_unreadable', tool: 'hebra_read_note', version: '0.4.0', mode: 'serve-http' }
    });
    expect(exception).toMatchObject({
      level: 'error',
      tags: { tool: 'hebra_create_note', kind: 'internal', version: '0.4.0', mode: 'serve-http' }
    });
    // La etiqueta `code` con texto libre no pasa la forma cerrada; tampoco las ajenas.
    expect(Object.keys(exception!.tags as object).sort()).toEqual(['kind', 'mode', 'tool', 'version']);
    const values = (exception!.exception as { values: Array<Record<string, unknown>> }).values;
    expect(values[0]).toMatchObject({ type: 'Error' });
    expect(values[0]).not.toHaveProperty('value');
    const frames = (values[0]!.stacktrace as { frames: Array<Record<string, unknown>> }).frames;
    expect(frames.some((frame) => frame.filename === 'error-reports.test.ts')).toBe(true);
    for (const key of ['user', 'extra', 'contexts', 'breadcrumbs', 'request', 'server_name', 'modules'])
      expect(exception).not.toHaveProperty(key);
  });

  it('scrubEvent rehace el evento con la lista blanca', () => {
    const scrubbed = scrubEvent({
      type: undefined,
      event_id: 'abc',
      level: 'error',
      message: `Nota ${SENSITIVE[1]}`,
      server_name: SENSITIVE[8],
      user: { id: SENSITIVE[7] },
      extra: { body: SENSITIVE[0] },
      contexts: { os: { name: 'macOS' } },
      breadcrumbs: [{ message: SENSITIVE[0] }],
      request: { headers: { Authorization: SENSITIVE[6] } },
      tags: { code: 'space_quota_exceeded', path: SENSITIVE[2], tool: 'hebra_list_notes' },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: SENSITIVE[5],
            stacktrace: {
              frames: [
                {
                  function: 'runCreateNote',
                  filename: `file://${SENSITIVE[2]}/dist/cli.mjs`,
                  abs_path: SENSITIVE[2],
                  lineno: 10,
                  context_line: SENSITIVE[0],
                  vars: { body: SENSITIVE[0] }
                }
              ]
            }
          }
        ]
      }
    });
    const text = JSON.stringify(scrubbed);
    for (const value of SENSITIVE) expect(text).not.toContain(value);
    expect(scrubbed.tags).toEqual({ code: 'space_quota_exceeded', tool: 'hebra_list_notes' });
    expect(scrubbed.exception?.values?.[0]).toEqual({
      type: 'TypeError',
      stacktrace: { frames: [{ function: 'runCreateNote', filename: 'cli.mjs', lineno: 10 }] }
    });
    expect(scrubbed).not.toHaveProperty('message');
  });
});

describe('avisos de servicio', () => {
  it('uno por código y herramienta cada intervalo', async () => {
    let at = 0;
    const sink = capture();
    configureErrorReports({ mode: 'stdio', version: '0.4.0' }, {}, { load: async () => Sentry, transport: sink.transport, now: () => at });
    reportServiceWarning('space_quota_exceeded', { tool: 'hebra_list_notes' });
    reportServiceWarning('space_quota_exceeded', { tool: 'hebra_list_notes' });
    reportServiceWarning('space_quota_exceeded', { tool: 'hebra_read_note' });
    at = WARNING_INTERVAL_MS + 1;
    reportServiceWarning('space_quota_exceeded', { tool: 'hebra_list_notes' });
    await flushErrorReports(1000);
    expect(sink.events().map((event) => (event.tags as Record<string, string>).tool)).toEqual([
      'hebra_list_notes',
      'hebra_read_note',
      'hebra_list_notes'
    ]);
  });

  it('relay_unavailable solo si se repite', async () => {
    const sink = capture();
    configureErrorReports({ mode: 'stdio', version: '0.4.0' }, {}, { load: async () => Sentry, transport: sink.transport, now: () => 0 });
    for (let i = 1; i < RELAY_UNAVAILABLE_REPEATS; i += 1) reportServiceWarning('relay_unavailable');
    await flushErrorReports(1000);
    expect(sink.events()).toHaveLength(0);
    reportServiceWarning('relay_unavailable');
    await flushErrorReports(1000);
    expect(sink.events().map((event) => event.message)).toEqual(['relay_unavailable']);
  });

  it('qué errores de herramienta avisan', () => {
    expect(serviceWarningOf('space_quota_exceeded')).toBe('space_quota_exceeded');
    expect(serviceWarningOf('space_key_unreadable')).toBe('space_key_unreadable');
    expect(serviceWarningOf('space_unavailable', { reason: 'rate_limited' })).toBe('rate_limited');
    expect(serviceWarningOf('space_unavailable', { reason: 'relay_unavailable' })).toBe('relay_unavailable');
    expect(serviceWarningOf('organizations_unavailable', { reason: 'credential_revoked' })).toBe('agent_revoked');
    expect(serviceWarningOf('space_access_denied')).toBeNull();
    expect(serviceWarningOf('not_found')).toBeNull();
    expect(serviceWarningOf('invalid_input')).toBeNull();
  });
});
