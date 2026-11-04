/**
 * globalSetup de vitest: construye UNA vez la biblioteca de prueba (las dos variantes de
 * `buildTestLibrary`) y la ofrece a los tests con `provide`. Así ningún test paga la construcción
 * con el motor (de 0,7 a 3 s, más con la máquina ocupada) dentro de su plazo.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { buildTestLibraryFresh, type TestLibrary } from './test-library';

export interface LibraryTemplates {
  plain: { library: TestLibrary };
  locked: { library: TestLibrary };
}

declare module 'vitest' {
  export interface ProvidedContext {
    libraryTemplates: LibraryTemplates;
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  const root = mkdtempSync(join(tmpdir(), 'hebra-mcp-templates-'));
  const plainDir = mkdtempSync(join(root, 'plain-'));
  const lockedDir = mkdtempSync(join(root, 'locked-'));
  const plain = await buildTestLibraryFresh(join(plainDir, 'library.sqlite'));
  const locked = await buildTestLibraryFresh(join(lockedDir, 'library.sqlite'), { lockedNote: true });
  project.provide('libraryTemplates', { plain: { library: plain }, locked: { library: locked } });
  return () => rmSync(root, { recursive: true, force: true });
}
