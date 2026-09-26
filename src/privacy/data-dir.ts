/**
 * Directorio de datos de hebra-mcp (SPEC.md §6.1, §6.3): `config.json` y, más adelante
 * (L2), la SQLite y `blobs/`. `HEBRA_MCP_DATA_DIR` lo sobreescribe (usado en tests, para
 * no tocar el directorio real del usuario).
 */
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HEBRA_MCP_DATA_DIR;
  if (override) return override;
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'hebra-mcp');
  }
  const xdg = env.XDG_DATA_HOME;
  if (xdg) return join(xdg, 'hebra-mcp');
  return join(homedir(), '.local', 'share', 'hebra-mcp');
}
