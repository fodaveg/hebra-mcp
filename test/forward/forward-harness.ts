/**
 * Soporte común de los tests de reenvío (`forward.*.test.ts`): directorios temporales,
 * hijos y servidores que se limpian solos, cliente MCP en memoria y el par escritor/lector
 * sobre el relé en memoria. Sin tests propios.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { WriterSocketServer } from "../../src/ipc/writer-socket";
import { registerTools } from "../../src/server/register-tools";
import type { ServerContext } from "../../src/server/context";
import {
  buildRoutedWriteContext,
  RoutedStatusSource,
  writerSocketHandlers,
} from "../../src/server/forward";
import { localWriteContext } from "../../src/server/serve";
import { LibraryInstance } from "../../src/sync/library-instance";
import { IDENTITY, InMemoryLibraryRelay, VAULT_KEY } from "../sync/devices";

export const BAIT_TEXT = "CEBO-TEXTO-conflicto-3b8e";
/** Configuración de privados vacía, para las peticiones crudas al socket. */
export const OPEN = { privateFolders: [], privateTags: [] };

const dirs: string[] = [];
const children: ChildProcess[] = [];
export const instances: LibraryInstance[] = [];
const clients: Array<{ client: Client; server: McpServer }> = [];
export const servers: Array<WriterSocketServer | Server> = [];

export function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hebra-mcp-fwdp-"));
  dirs.push(dir);
  return dir;
}

/** Un proceso vivo cuyo PID declara el lector (así no puede tomar el bloqueo). */
export function livePid(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  children.push(child);
  return child.pid!;
}

export function textOf(result: CallToolResult): string {
  return result.content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

export async function connect(ctx: ServerContext): Promise<Client> {
  const server = new McpServer({
    name: "hebra-mcp-forward-test",
    version: "0.0.0",
  });
  registerTools(server, ctx);
  const client = new Client({
    name: "hebra-mcp-forward-client",
    version: "0.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  clients.push({ client, server });
  return client;
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as CallToolResult;
  return {
    isError: result.isError === true,
    value: JSON.parse(textOf(result)) as Record<string, unknown>,
  };
}

let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

export function stderrText(): string {
  return (stderrSpy!.mock.calls as unknown as [string][])
    .map(([line]) => String(line))
    .join("");
}

/** Registra los ganchos de limpieza en el fichero de test que la llama. */
export function useForwardHarness(): void {
  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(async () => {
    for (const { client, server } of clients.splice(0)) {
      await client.close();
      await server.close();
    }
    for (const instance of instances.splice(0)) await instance.close();
    for (const server of servers.splice(0)) {
      if (server instanceof WriterSocketServer) await server.close();
      else await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await exited;
      }
    }
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
    stderrSpy?.mockRestore();
    stderrSpy = undefined;
  });
}

export async function pair(options: { blobs?: boolean } = {}) {
  const dataDir = tempDataDir();
  const relay = new InMemoryLibraryRelay();
  const sync = {
    transport: relay,
    blobTransport: options.blobs ? relay : null,
    identity: IDENTITY,
    vaultKey: VAULT_KEY,
    intervalMs: null,
  };
  const writer = await LibraryInstance.open({
    dataDir,
    sync,
    checkIntervalMs: null,
    lock: { releaseOnExit: false },
    writerSocket: (opened) =>
      writerSocketHandlers(localWriteContext(opened), opened),
  });
  instances.push(writer);
  await writer.whenReady(5_000);
  const reader = await LibraryInstance.open({
    dataDir,
    sync,
    checkIntervalMs: null,
    lock: { releaseOnExit: false, pid: livePid() },
  });
  instances.push(reader);
  const readerCtx: ServerContext = {
    port: reader.port,
    privacyConfig: { privateFolders: [], privateTags: [] },
    status: new RoutedStatusSource(reader, true),
    write: buildRoutedWriteContext(reader, localWriteContext(reader)),
  };
  return { dataDir, relay, writer, reader, client: await connect(readerCtx) };
}
