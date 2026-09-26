import type { HebraLibraryPort } from '../store/types';
import type { PrivacyFilter } from '../privacy/filter';
import type { StatusSource } from '../status/status-source';

/** Todo lo que una herramienta necesita: el almacén (SPEC.md §5), el filtro de privados
 *  ya construido (§6.3) y la fuente de estado (§5, `hebra_status`). */
export interface ServerContext {
  port: HebraLibraryPort;
  privacy: PrivacyFilter;
  status: StatusSource;
}
