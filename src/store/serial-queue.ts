/**
 * Cola FIFO de un solo vuelo sobre el almacén, el equivalente en proceso del que usa
 * `LocalLibraryPort` de Hebra (`$lib/library/local-port`, cabecera «COLA FIFO DE UN
 * SOLO VUELO»). Hace falta por lo mismo que allí: `SqliteLibraryEngine` abre
 * `BEGIN IMMEDIATE` y hace `await` DENTRO de la transacción (`transaction()` en
 * `sqlite-engine.ts` espera a la operación aunque sea síncrona, y `noteSave` calcula
 * antes un SHA-256 asíncrono), así que suelta el hilo con la transacción abierta. En
 * hebra-mcp, una ronda de sync (`SyncRunner`) y una escritura de una herramienta
 * pueden llegar a la vez sobre la MISMA conexión: sin esta cola, la segunda
 * `BEGIN IMMEDIATE` falla con «cannot start a transaction within a transaction».
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Encadena `operation` detrás de lo que ya estuviera en cola, haya terminado bien o
   *  mal (un fallo no deja la cola bloqueada). Cada llamante recibe SU resultado o
   *  error, intacto. */
  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Resuelve cuando termina todo lo que ya estaba en cola (para cerrar la conexión sin
   *  cortar una transacción a medias). */
  whenIdle(): Promise<void> {
    return this.run(() => undefined);
  }
}
