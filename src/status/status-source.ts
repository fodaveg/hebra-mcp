/**
 * `hebra_status` (SPEC.md §5). `StatusSource` es la interfaz inyectable que separa el
 * servidor MCP de quién sabe el estado: `UnlinkedStatusSource` (sin nada que abrir, o
 * tests) y `LibraryInstanceStatusSource` (sobre `LibraryInstance` de L3a: escritor
 * único, `pendingUpload`, `errorsByCode` reales). Ninguna de las dos sabe de
 * emparejado todavía (`linked` es L2): siempre `false` hasta que exista.
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

/** Sin nada que abrir (o en tests que no necesitan `LibraryInstance`): todo a `null`. */
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

/** Lo que ya sabe una `LibraryInstance` de L3a (escritor único, §8): sin `linked`
 *  todavía (L2), que aquí siempre es `false`. */
export interface InstanceStatusLike {
  status(): Promise<{
    lastSyncAt: string | null;
    lastSyncOutcome: string | null;
    pendingUpload: number;
    errorsByCode: Record<string, number>;
    revoked: boolean;
    writer: 'this' | 'other_instance';
  }>;
}

export class LibraryInstanceStatusSource implements StatusSource {
  constructor(private readonly instance: InstanceStatusLike) {}

  async getStatus(): Promise<HebraStatus> {
    const status = await this.instance.status();
    return { linked: false, ...status };
  }
}
