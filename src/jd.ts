/**
 * Punto de entrada del motor JD puro de jdex-manager (`vendor/jdex-manager`, submódulo
 * público con licencia MIT, fijado a un SHA; D18 de SPEC.md §3). Todo lo que hebra-mcp usa
 * del motor entra por aquí y solo desde `src/jd/public.ts` del submódulo, que es la
 * superficie estable que jdex-manager publica para los anfitriones que no son Obsidian:
 * TS estándar, sin Obsidian, Node ni DOM, y rutas relativas a la biblioteca con «/».
 *
 * El motor es de la sesión de jdex-manager: aquí solo se lee. Si algo no encaja, se cuenta
 * allí; no se parchea el submódulo desde este repo.
 */
export * from '../vendor/jdex-manager/src/jd/public';
