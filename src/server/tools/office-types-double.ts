/**
 * Doble de los tipos del contrato de importación (`contrato-importacion.md`, "Contrato
 * TypeScript congelado"): copia LITERAL de `src/lib/office-import/types.ts` de Hebra, para que
 * C-25 se termine sin esperar al hito C-05. C-36 borra este fichero y `import-office.ts`
 * importa entonces los tipos reales de `vendor/hebra`. No se edita a mano: si el contrato
 * cambia, se vuelve a copiar.
 */

// Una fase 2 añadiría 'xls', 'ppt' y 'doc' a esta unión y sus convertidores al registro.
export type OfficeFormat = 'xlsx' | 'pptx' | 'docx';
export type OfficeImportMode = 'convert-and-keep' | 'convert-only' | 'keep-only';

export type ConversionLoss = { kind: string; count: number; label: string };

export type ConversionBlockReason = 'encrypted' | 'corrupt' | 'too_large' | 'unsupported_version';

export type ConversionPreview =
  | { format: OfficeFormat; convertible: true; losses: ConversionLoss[] }
  | { format: OfficeFormat; convertible: false; reason: ConversionBlockReason; losses: [] };

export type ConversionAsset = { name: string; mime: string; bytes: Uint8Array };

export type ConversionOutput =
  | { kind: 'note'; title: string; markdown: string; assets: ConversionAsset[] }
  | { kind: 'file'; name: string; mime: string; bytes: Uint8Array };

export type ConversionResult = { output: ConversionOutput; losses: ConversionLoss[] };

export type ConversionInput = {
  bytes: Uint8Array;
  fileName: string;
  format: OfficeFormat;
  signal: AbortSignal;
  /** Tope de tiempo de cálculo. Al superarlo se lanza `ConversionError('too_large')`. */
  budgetMs: number;
};

export type ConversionFailureCode = ConversionBlockReason | 'cancelled' | 'internal';

export class ConversionError extends Error {
  constructor(
    readonly code: ConversionFailureCode,
    /** Texto para el usuario, sin contenido del documento. */
    readonly userMessage: string
  ) {
    super(code);
  }
}

export interface OfficeConverter {
  readonly formats: readonly OfficeFormat[];
  analyze(input: ConversionInput): Promise<ConversionPreview>;
  /** Si falla, lanza `ConversionError`. La pieza común guarda entonces el original (regla 2). */
  convert(input: ConversionInput): Promise<ConversionResult>;
}
