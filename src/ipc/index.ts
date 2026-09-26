/** Reenvío de escrituras del lector al escritor único (SPEC.md §8). */
export {
  WriterSocketServer,
  WriterUnavailableError,
  WriterRemoteError,
  WRITER_SOCKET_FILE,
  MAX_MESSAGE_BYTES,
  isWriterUnavailable,
  requestWriter,
  type WriterSocketErrorCode,
  type WriterSocketHandlers,
  type WriterSocketOp,
  type WriterSocketServerOptions,
  type WriterSyncStatus,
  type WriterUnavailableReason
} from './writer-socket';
