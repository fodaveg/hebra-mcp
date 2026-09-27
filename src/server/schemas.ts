/**
 * Esquemas de entrada de las herramientas de lectura (SPEC.md §5), con los límites de la
 * tabla. Los tramos por defecto (`limit`) se aplican en cada `tools/*.ts`, no aquí: así
 * el esquema deja el campo opcional y el JSON Schema publicado no promete un valor fijo
 * que luego se recorta.
 */
import { z } from 'zod';

export const searchInputShape = {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  folder: z.string().optional(),
  tag: z.string().optional()
};

export const listNotesInputShape = {
  folder: z.string().optional(),
  /** Con `folder`, incluye también las notas de sus subcarpetas (carpetas reales,
   *  decisión de David del 27 sep 2026). Ausente o `false`: solo las directas, como
   *  siempre. Sin `folder`, no tiene efecto. */
  subfolders: z.boolean().optional(),
  tag: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional()
};

export const readNoteInputShape = {
  id: z.string().optional(),
  title: z.string().optional()
};

export const linksInputShape = {
  id: z.string()
};

/** Sin `.max()` a propósito (SPEC.md §5, L3b): el límite de `body` lo aplica
 *  `create-note.ts` con `invalid_input`, sin eco de la entrada. */
export const createNoteInputShape = {
  body: z.string(),
  folder: z.string().optional()
};

/** Sin `.max()`: el límite de `text` lo aplica `append-to-note.ts`. */
export const appendToNoteInputShape = {
  id: z.string(),
  text: z.string()
};
