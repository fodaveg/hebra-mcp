/**
 * Genera una biblioteca sintética de Hebra con el motor real (SqliteLibraryEngine sobre
 * node:sqlite, WAL, FsBlobStore), como la deja el escritor de hebra-mcp.
 * Uso: node gen.mjs <dataDir> <notas> <blobsMiB> [semilla]   (lo lanza `scripts/mem/run.mjs`)
 * Contenido: texto pseudoaleatorio sin datos personales; ~40 carpetas, 5 etiquetas y 2
 * enlaces por nota, cuerpos de 0,5-6 KB y 3 notas grandes de 400 KB.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deriveNote, SqliteLibraryEngine } from '../../src/hebra';
import { openNodeSqliteConn } from '../../src/store/sqlite-conn-node';
import { FsBlobStore } from '../../src/store/blob-store-fs';

const [dataDir, notesArg, blobsArg, seedArg] = process.argv.slice(2);
const N = Number(notesArg);
const BLOB_MIB = Number(blobsArg ?? 0);
let seed = Number(seedArg ?? 7);
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const WORDS = 'alfa bravo charlie delta eco foxtrot golf hotel india julieta kilo lima mike noviembre oscar papa quebec romeo sierra tango uniforme victor whisky xray yanqui zulu casa perro gato agua fuego tierra viento libro mesa silla puerta ventana camino ciudad pueblo montaña río mar cielo nube sol luna estrella tiempo día noche'.split(' ');
const word = () => WORDS[Math.floor(rnd() * WORDS.length)];
function para(chars: number): string {
  let s = '';
  while (s.length < chars) s += word() + (rnd() < 0.08 ? '.\n' : ' ');
  return s;
}

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const { db, conn } = openNodeSqliteConn(join(dataDir, 'library.sqlite'), 'readWrite');
const engine = await SqliteLibraryEngine.open(conn, 'Gen', { journalMode: 'WAL', blobs: new FsBlobStore(dataDir) });
const folders: string[] = [];
for (let i = 0; i < 8; i += 1) folders.push((await engine.folderCreate(null, `Area ${i}`)).id);
for (let i = 0; i < 32; i += 1) folders.push((await engine.folderCreate(folders[i % 8], `Sub ${i}`)).id);
const titles: string[] = [];
const blobCount = BLOB_MIB > 0 ? Math.max(1, Math.round(BLOB_MIB / 2)) : 0;
for (let b = 0; b < blobCount; b += 1) {
  const bytes = new Uint8Array(2 * 1024 * 1024);
  for (let k = 0; k < bytes.length; k += 4096) bytes[k] = Math.floor(rnd() * 256);
  bytes[0] = b & 255; bytes[1] = (b >> 8) & 255;
  await engine.blobPut(bytes, { mime: 'application/octet-stream' });
}
const t0 = Date.now();
for (let i = 0; i < N; i += 1) {
  const big = i < 3 && N >= 200;
  const title = `Nota ${i} ${word()} ${word()}`;
  titles.push(title);
  const tags = Array.from({ length: 5 }, () => `#t${Math.floor(rnd() * 300)}/${word()}`).join(' ');
  const links = i > 2 ? `[[${titles[Math.floor(rnd() * (i - 1))]}]] [[${titles[Math.floor(rnd() * (i - 1))]}]]` : '';
  const props = `---\nestado: ${word()}\nprioridad: ${Math.floor(rnd() * 5)}\n---\n`;
  const body = `${props}# ${title}\n\n${tags}\n\n${para(big ? 400_000 : 500 + Math.floor(rnd() * 5500))}\n\n${links}\n`;
  const note = await engine.noteCreate(folders[Math.floor(rnd() * folders.length)]);
  const d = deriveNote(body);
  await engine.noteSave({ id: note.id, body, title: d.title, titleNorm: d.titleNorm, excerpt: d.excerpt,
    tags: d.tags, links: d.links, blobRefs: d.blobRefs, props: d.props, expectedLocalSeq: note.localSeq,
    baseBodySha256: note.bodySha256 });
}
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
console.log(JSON.stringify({ notes: N, blobs: blobCount, ms: Date.now() - t0 }));
