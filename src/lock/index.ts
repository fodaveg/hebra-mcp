/** Escritor único entre procesos (SPEC.md §8, R4). */
export {
  WriterLock,
  WRITER_LOCK_FILE,
  processIsAlive,
  type WriterLockOptions
} from './writer-lock';
