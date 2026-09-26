/**
 * `hebra_status` (SPEC.md §5): en L1 no hay vínculo ni sync, así que `linked: false` y
 * los campos de sync a `null`. `StatusSource` es la interfaz inyectable que L3a
 * implementará con el estado real del emparejado, el escritor único (§8) y el bucle de
 * sync; el servidor MCP (L1) solo conoce esta interfaz, nunca su implementación.
 */
export interface HebraStatus {
  linked: boolean;
  lastSyncAt: string | null;
  lastSyncOutcome: string | null;
  pendingUpload: number | null;
  errorsByCode: Record<string, number> | null;
  writer: 'this' | 'other_instance' | null;
  revoked: boolean | null;
}

export interface StatusSource {
  getStatus(): HebraStatus | Promise<HebraStatus>;
}

/** Fuente por defecto de L1: sin emparejado, sin sync. */
export class UnlinkedStatusSource implements StatusSource {
  getStatus(): HebraStatus {
    return {
      linked: false,
      lastSyncAt: null,
      lastSyncOutcome: null,
      pendingUpload: null,
      errorsByCode: null,
      writer: null,
      revoked: null
    };
  }
}
