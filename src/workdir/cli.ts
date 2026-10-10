/**
 * Subórdenes de los ficheros de trabajo (SPEC.md §13) para `hebra-mcp`
 * (`src/server/main.ts`): lee los argumentos, abre la biblioteca solo cuando la orden lo
 * necesita y devuelve el código de salida. Aquí stdout es para quien lanza la orden (un
 * agente o David); stderr lleva los eventos cerrados de siempre y los errores.
 */
import { parseArgs } from 'node:util';
import {
  applyCommand,
  checkoutCommand,
  diffCommand,
  statusCommand,
  undoCommand,
  UsageError,
  type CommandIo,
  type OpenLibrary
} from './commands';
import { WorkdirError } from './layout';

export const WORKDIR_COMMANDS = ['checkout', 'apply', 'undo', 'status', 'diff'] as const;
export type WorkdirCommand = (typeof WORKDIR_COMMANDS)[number];

export const WORKDIR_USAGE = [
  '  hebra-mcp checkout --dir <carpeta> (--all | --consulta <texto>… | --titulo <título>… | --carpeta <ruta>…) [--forzar]',
  '  hebra-mcp apply [--dir <carpeta>] [--conflicto copia|rechazar] [--simular]',
  '  hebra-mcp undo --lote <lote> [--dir <carpeta>]',
  '  hebra-mcp status [--dir <carpeta>] [--rutas]',
  '  hebra-mcp diff [--dir <carpeta>] [--stat] [ficheros…]'
];

export function isWorkdirCommand(value: string | undefined): value is WorkdirCommand {
  return (WORKDIR_COMMANDS as readonly string[]).includes(value ?? '');
}

/** Ejecuta la orden. Un error de uso o de la carpeta de trabajo se dice y sale con 2. */
export async function runWorkdirCommand(
  command: WorkdirCommand,
  argv: string[],
  io: CommandIo & { err(line: string): void },
  open: OpenLibrary
): Promise<number> {
  try {
    switch (command) {
      case 'checkout': {
        const { values } = parseArgs({
          args: argv,
          options: {
            dir: { type: 'string' },
            all: { type: 'boolean', default: false },
            consulta: { type: 'string', multiple: true, default: [] },
            titulo: { type: 'string', multiple: true, default: [] },
            carpeta: { type: 'string', multiple: true, default: [] },
            forzar: { type: 'boolean', default: false }
          },
          strict: true
        });
        return await checkoutCommand(io, open, {
          dir: values.dir,
          all: values.all,
          consultas: values.consulta,
          titulos: values.titulo,
          carpetas: values.carpeta,
          forzar: values.forzar
        });
      }
      case 'apply': {
        const { values } = parseArgs({
          args: argv,
          options: {
            dir: { type: 'string' },
            conflicto: { type: 'string', default: 'copia' },
            simular: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false }
          },
          strict: true
        });
        if (values.conflicto !== 'copia' && values.conflicto !== 'rechazar') {
          throw new UsageError('apply: --conflicto es «copia» o «rechazar»');
        }
        return await applyCommand(io, open, {
          dir: values.dir,
          conflicto: values.conflicto,
          simular: values.simular || values['dry-run']
        });
      }
      case 'undo': {
        const { values } = parseArgs({
          args: argv,
          options: { dir: { type: 'string' }, lote: { type: 'string' } },
          strict: true
        });
        if (!values.lote) throw new UsageError('undo: falta --lote <lote> (lo imprime apply)');
        return await undoCommand(io, open, { dir: values.dir, lote: values.lote });
      }
      case 'status': {
        const { values } = parseArgs({
          args: argv,
          options: { dir: { type: 'string' }, rutas: { type: 'boolean', default: false } },
          strict: true
        });
        return statusCommand(io, { dir: values.dir, rutas: values.rutas });
      }
      case 'diff': {
        const { values, positionals } = parseArgs({
          args: argv,
          options: { dir: { type: 'string' }, stat: { type: 'boolean', default: false } },
          allowPositionals: true,
          strict: true
        });
        return diffCommand(io, { dir: values.dir, stat: values.stat, files: positionals });
      }
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof WorkdirError) {
      io.err(error.message);
      return 2;
    }
    // `parseArgs` con una opción desconocida o sin valor.
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) {
      io.err(`${command}: ${(error as Error).message}`);
      return 2;
    }
    throw error;
  }
}
