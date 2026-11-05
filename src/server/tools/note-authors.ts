/**
 * `hebra_note_authors` (D23, 5 nov 2026): quién escribió una nota, por `id` (y `space`).
 *
 * El motor guarda dos columnas por nota (`noteAuthors`): `author_id`, lo que dijo el sobre
 * cifrado del dispositivo que la subió, y `relay_author_id`, lo que selló el relé al
 * aceptarla. Las dos son IDs de CUENTA (el `accountId` de un miembro de una organización,
 * no un identificador de dispositivo), y la interfaz de Hebra se fía del segundo
 * (`editedBy`, `docs/SPEC-HEBRA-COMO-BEAR.md` §23.5). Solo existen en un espacio compartido:
 * en la biblioteca personal las dos son `null`.
 *
 * Un ID de cuenta no le dice nada a un agente, así que se cruza con el directorio de la
 * persona (`ServerContext.directory`, el de `hebra_list_organizations`): de ahí salen `name`
 * (puede ser `null` aunque se encuentre), `role` (solo el de la organizacion dueña del espacio de la nota; `null` si la cuenta no es miembro de ella o no se sabe cual es) y `isSelf`. No se inventa nada: sin
 * directorio (stdio, relé sin publicar, 429…) o con una cuenta que ya no es miembro, el
 * `accountId` sale tal cual, con `name`, `role` e `isSelf` a `null`, y `namesResolved` lo
 * dice. Los nombres se buscan en todas las organizaciones de la persona, no solo en la del
 * espacio: una cuenta es la misma en todas.
 *
 * Privacidad (SPEC.md §6.3): se juzga con el mismo filtro que `hebra_read_note`
 * (`ctx.privacy.visibleMeta`). Una nota oculta, en la papelera o inexistente responde igual,
 * `not_found`, y el directorio solo se pide si la nota se ve.
 */
import { usageOf, type DirectoryView, type ToolContext } from '../context';
import { ToolError } from '../errors';

export interface NoteAuthorRef {
  accountId: string;
  /** El nombre que da el directorio; `null` si no se conoce. */
  name: string | null;
  /** `admin`, `manager` o `member` si la cuenta está en el directorio; si no, `null`. */
  role: string | null;
  /** `true` si es la persona de este agente; `null` sin directorio con que compararlo. */
  isSelf: boolean | null;
}

export interface NoteAuthorsOutput {
  id: string;
  /** Quién editó la última revisión confirmada, según el relé; `null` si no se sabe (nota
   *  personal, sin subir, copia de conflicto o cuenta borrada). */
  lastEditor: (NoteAuthorRef & { actorKind?: 'app' | 'agent' }) | null;
  /** La cuenta que dijo el sobre; `null` si no dijo nada. */
  declaredAuthorId: string | null;
  /** El sobre y el relé dicen cuentas distintas: Hebra enseña la del relé y un aviso. */
  mismatch: boolean;
  /** El directorio se pudo leer (lo que `name`, `role` e `isSelf` necesitan). */
  namesResolved: boolean;
}

export async function runNoteAuthors(
  ctx: ToolContext,
  input: { id: string },
  directory?: () => Promise<DirectoryView>,
  spaceId?: string
): Promise<NoteAuthorsOutput> {
  const meta = ctx.privacy.visibleMeta(input.id);
  if (!meta) throw new ToolError('not_found');
  const authors = await ctx.port.noteAuthors(input.id);
  // De esta fila: la puerta final la vuelve a juzgar antes de responder.
  const used = usageOf(ctx);
  used.note(input.id);
  used.folder(meta.folderId, ctx.privacy.folderPath(meta.folderId));

  const accounts = [authors.relayAuthorId, authors.authorId].filter(
    (account): account is string => account !== null
  );
  let view: DirectoryView | null = null;
  if (accounts.length > 0 && directory) {
    try {
      view = await directory();
    } catch (error) {
      // Sin directorio no se pueden dar nombres, pero el autor sale igual.
      if (!(error instanceof ToolError)) throw error;
    }
  }
  const ref = (accountId: string): NoteAuthorRef => {
    if (!view) return { accountId, name: null, role: null, isSelf: null };
    let name: string | null = null;
    let role: string | null = null;
    for (const organization of view.directory.organizations) {
      const member = organization.members.find((entry) => entry.accountId === accountId);
      if (!member) continue;
      name ??= member.name ?? null;
      // El rol solo vale en la organizacion dueña del espacio de la nota: ser admin en otra
      // no dice nada de este espacio.
      if (spaceId !== undefined && organization.spaces.some((space) => space.spaceId === spaceId)) {
        role = member.role;
      }
    }
    return { accountId, name, role, isSelf: accountId === view.selfAccountId };
  };

  const relay = authors.relayAuthorId;
  return {
    id: input.id,
    lastEditor:
      relay === null
        ? null
        : { ...ref(relay), ...(authors.relayActorKind ? { actorKind: authors.relayActorKind } : {}) },
    declaredAuthorId: authors.authorId,
    mismatch: authors.authorId !== null && relay !== null && authors.authorId !== relay,
    namesResolved: view !== null
  };
}
