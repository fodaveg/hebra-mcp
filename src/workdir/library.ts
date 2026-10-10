/**
 * La biblioteca vista desde los ficheros de trabajo (SPEC.md §13.6): el MISMO dispositivo
 * local emparejado que `hebra-mcp serve`, abierto igual (`openServeContext`: secretos del
 * llavero, `writer.lock`, `writer.sock` y el filtro de privados de `config.json`).
 *
 * - Si nadie tiene `writer.lock`, este proceso es el escritor mientras dura la orden:
 *   escribe en su SQLite, sincroniza y atiende en `writer.sock` lo que le reenvíen otras
 *   sesiones. Al cerrar suelta el bloqueo.
 * - Si otro proceso (un `serve` por stdio, o `serve-http`) es el escritor, este es lector:
 *   lee de la réplica en solo lectura (WAL) y reenvía las escrituras por `writer.sock`
 *   (`replaceBody`, `trashConflictCopies`, `syncRound`), con el relevo de siempre si el
 *   escritor ya no responde (`routeWrite`, `src/server/forward.ts`). Un escritor de una
 *   versión anterior responde `invalid_request` a esas ops: la orden lo dice y no escribe.
 *
 * Ronda de sync: `syncRound` la pide y la espera como mucho `AWAIT_ROUND_TIMEOUT_MS`, en
 * el escritor que sea. Sin emparejar, `no_sync`.
 */
import type { PrivacyConfig } from '../privacy/config';
import {
  routeWrite,
  type ForwardOptions
} from '../server/forward';
import { localWriteContext, openServeContext, type OpenServeOptions } from '../server/serve';
import { AWAIT_ROUND_TIMEOUT_MS, type RoundWait } from '../server/write-context';
import type {
  ReplaceBodyInput,
  ReplaceBodyResult,
  ReplaceBodyTestHooks,
  TrashConflictCopiesInput,
  TrashConflictCopiesResult
} from '../store/body-writes';
import type { HebraLibraryPort } from '../store/types';
import type { WriterRole } from '../sync/library-instance';

export interface WorkdirLibrary {
  /** `this`: este proceso es el escritor; `other_instance`: reenvía al escritor. */
  readonly role: WriterRole;
  /** ¿Hay secretos de `pair` (y por tanto sync)? */
  readonly linked: boolean;
  /** Lecturas (en un lector, la réplica en solo lectura). */
  readonly port: HebraLibraryPort;
  readonly privacyConfig: PrivacyConfig;
  syncRound(): Promise<RoundWait>;
  replaceBody(input: Omit<ReplaceBodyInput, 'privacy'>): Promise<ReplaceBodyResult>;
  trashConflictCopies(
    input: Omit<TrashConflictCopiesInput, 'privacy'>
  ): Promise<TrashConflictCopiesResult>;
  close(): Promise<void>;
}

export interface OpenWorkdirLibraryOptions extends OpenServeOptions {
  /** Tests: sabotaje del paso «ya estaba» (solo en el camino local, nunca por el socket). */
  hooks?: ReplaceBodyTestHooks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocolError(): Error {
  return new Error('writer_protocol');
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;

function asCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw protocolError();
  return value;
}

/** Valida el `ReplaceBodyResult` que devuelve el escritor (no se fía de su forma). */
export function asReplaceBodyResult(value: unknown): ReplaceBodyResult {
  if (!isRecord(value)) throw protocolError();
  switch (value.outcome) {
    case 'applied':
    case 'already':
      if (typeof value.bodySha256 !== 'string' || !SHA256_HEX.test(value.bodySha256)) {
        throw protocolError();
      }
      return { outcome: value.outcome, localSeq: asCount(value.localSeq), bodySha256: value.bodySha256 };
    case 'conflict_copy':
      if (typeof value.copyId !== 'string' || typeof value.reused !== 'boolean') throw protocolError();
      return { outcome: 'conflict_copy', copyId: value.copyId, reused: value.reused };
    case 'conflict_rejected':
    case 'unavailable':
    case 'locked':
      return { outcome: value.outcome };
    default:
      throw protocolError();
  }
}

function asTrashResult(value: unknown): TrashConflictCopiesResult {
  if (!isRecord(value)) throw protocolError();
  return { trashed: asCount(value.trashed), already: asCount(value.already), changed: asCount(value.changed) };
}

function asRoundWait(value: unknown): RoundWait {
  if (!isRecord(value)) throw protocolError();
  if (value.kind === 'timeout' || value.kind === 'no_sync') return { kind: value.kind };
  if (value.kind === 'done' && typeof value.result === 'string') return { kind: 'done', result: value.result };
  throw protocolError();
}

export async function openWorkdirLibrary(options: OpenWorkdirLibraryOptions): Promise<WorkdirLibrary> {
  const { ctx, instance, linked, close } = await openServeContext(options);
  const { privacyConfig } = ctx;
  // La ronda en local (este proceso es el escritor, o lo pasa a ser con el relevo).
  const local = localWriteContext(instance);
  const forward: ForwardOptions | undefined = options.forward;
  return {
    get role() {
      return instance.role;
    },
    linked,
    port: ctx.port,
    privacyConfig,
    syncRound: () =>
      routeWrite(instance, 'syncRound', {}, asRoundWait, () => local.awaitRound(AWAIT_ROUND_TIMEOUT_MS), forward),
    replaceBody: (input) => {
      const full: ReplaceBodyInput = { ...input, privacy: privacyConfig };
      return routeWrite(
        instance,
        'replaceBody',
        { ...full },
        asReplaceBodyResult,
        () => instance.replaceBodyLocal(full, options.hooks),
        forward
      );
    },
    trashConflictCopies: (input) => {
      const full: TrashConflictCopiesInput = { ...input, privacy: privacyConfig };
      return routeWrite(
        instance,
        'trashConflictCopies',
        { ...full },
        asTrashResult,
        () => instance.trashConflictCopiesLocal(full),
        forward
      );
    },
    close
  };
}
