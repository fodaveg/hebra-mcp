/**
 * La terminal de `pair`/`unpair`: lo que David lee y contesta. Va por stdout y stdin; los
 * logs (stderr) son otra cosa y nunca llevan lo que se imprime aquí (SPEC.md §6.4, §7.3:
 * los títulos de la verificación solo se ven aquí).
 *
 * `openInBrowser` abre la URL de emparejado con el programa del sistema (`open` en macOS,
 * `xdg-open` en Linux) pasándola como argumento: la URL solo lleva `deviceId`, la etiqueta,
 * el `webOrigin` y el `code_challenge`, ningún secreto. En otra plataforma, o si falla,
 * devuelve `false` y `pair` la deja impresa para abrirla a mano.
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { createInterface } from 'node:readline/promises';

export interface PairTerminal {
  print(line: string): void;
  /** `true` solo con un «si» explícito (o «sí», «s», «yes», «y»). */
  confirm(question: string): Promise<boolean>;
  /** `false` sin una terminal interactiva de verdad (pipe, `/dev/null`, prefijo `!` de
   *  Claude Code): sin ella, `confirm` no puede recibir un «si» de David. */
  isTTY(): boolean;
}

const YES = new Set(['si', 'sí', 's', 'yes', 'y']);

export function isYes(answer: string): boolean {
  return YES.has(answer.trim().toLowerCase());
}

/** stdout + stdin del proceso. `close()` libera stdin al terminar. */
export function stdioTerminal(): PairTerminal & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    print(line) {
      process.stdout.write(`${line}\n`);
    },
    async confirm(question) {
      return isYes(await rl.question(`${question}: `));
    },
    isTTY() {
      return process.stdin.isTTY === true;
    },
    close() {
      rl.close();
    }
  };
}

/** Programa del sistema que abre una URL, por plataforma medida con `os.platform()`. */
function openerFor(os: NodeJS.Platform): string | null {
  switch (os) {
    case 'darwin':
      return 'open';
    case 'linux':
      return 'xdg-open';
    default:
      return null;
  }
}

export function openInBrowser(url: string): Promise<boolean> {
  const opener = openerFor(platform());
  if (opener === null) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
