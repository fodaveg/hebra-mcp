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
