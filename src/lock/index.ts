/** Escritor único entre procesos (SPEC.md §8, R4) y servidor único por `/data` (D22, §12.10). */
export {
  WriterLock,
  WRITER_LOCK_FILE,
  classifyWriterLock,
  processIsAlive,
  type ClassifyWriterLockOptions,
  type WriterLockOptions,
  type WriterLockOwner
} from './writer-lock';
export { acquireServerLock, SERVER_LOCK_FILE, type ServerLock } from './server-lock';
