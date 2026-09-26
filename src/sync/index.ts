/**
 * Punto de entrada del sync y de la instancia (SPEC.md §8, L3) para el servidor y para
 * `scripts/build.mjs`.
 */
export {
  SyncRunner,
  SYNC_INTERVAL_MS,
  STARTUP_READ_WAIT_MS,
  type SyncConflictCopy,
  type SyncEmit,
  type SyncLogEventName,
  type SyncLogFields,
  type SyncRunnerOptions,
  type SyncStatusSnapshot,
  type SyncStatusSource
} from './runner';
export {
  LibraryInstance,
  LIBRARY_SQLITE_FILE,
  WRITER_CHECK_INTERVAL_MS,
  type InstanceStatus,
  type LibrarySyncConfig,
  type OpenLibraryInstanceOptions,
  type WriterRole
} from './library-instance';
