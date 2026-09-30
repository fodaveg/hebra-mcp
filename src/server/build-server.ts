import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from './context';
import { SERVER_INSTRUCTIONS } from './capabilities';
import { registerTools } from './register-tools';

/** Nombre y versión que ve el cliente MCP en `initialize` (SPEC.md §7.5:
 *  `claude mcp add hebra -- hebra-mcp serve`). */
export function buildMcpServer(ctx: ServerContext, version: string): McpServer {
  const server = new McpServer(
    { name: 'hebra-mcp', version },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerTools(server, ctx, version);
  return server;
}
