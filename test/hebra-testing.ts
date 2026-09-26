/**
 * Punto de entrada de PRUEBAS de Hebra para Node
 * (`vendor/hebra/src/lib/library/node-testing.ts`, lote L6c de Hebra, petición P1):
 * dobles en memoria del relé y de los almacenes de bytes, y los casos compartidos del
 * almacén (`libraryCases`), con una ruta relativa y sin el alias `$lib`. Espejo de
 * `../src/hebra.ts` para el código de PRUEBA: nada de aquí se usa fuera de `test/`
 * (`node-testing.ts` no se mezcla con `node.ts`, el punto de entrada de producción).
 */
export * from '../vendor/hebra/src/lib/library/node-testing';
