# Dónde y cómo se escriben ciertas notas

Léelo antes de guardar en Hebra un relevo entre sesiones, un changelog, un borrador o la nota de
decisiones de un agente, o un audit, informe, análisis o lista de ideas que haya pedido el
usuario. Si las instrucciones del usuario o del repo fijan otra carpeta, otra nota o otro
formato, mandan ellas.

## Relevos, changelogs y documentos efímeros

En una biblioteca con Johnny.Decimal, los relevos entre sesiones, los changelogs y cualquier
documento de vida corta de un proyecto (partes de estado, notas de trabajo de un lote,
borradores que se van a tirar) van a la carpeta `.05` de la categoría del proyecto, nunca a la
carpeta del ID del proyecto ni a su raíz. Para un proyecto `21.11`, la `21.05`.

El criterio es **para quién es la nota y si tiene que durar**, no quién la pidió. Va a la `.05`
todo lo que el agente escribe para sí o para el siguiente agente (relevos, informes de trabajo de
un lote, borradores, listas de pasos, volcados, notas de sesión, changelogs). Se queda en la
carpeta de su proyecto lo que el usuario va a leer y tiene que durar: audits, specs, planes,
informes e ideas, también si el agente los hizo por su cuenta. Lo que no es de ninguna categoría
(entorno, infraestructura de los agentes, el propio sistema) va a la `.05` de la categoría de
gestión del sistema, la `00.05`.

Sin Johnny.Decimal, van a la carpeta que designen el usuario o el repo. Si no hay ninguna,
pregunta dónde, sin crear tú una carpeta para ellos. Lo que sigue es solo para Johnny.Decimal.

1. **Directamente en la `.05`, sin subcarpetas por proyecto.** Si la `.05` tiene una nota léeme
   con sus reglas (título con fecha, proyecto y asunto; qué va a la papelera al cerrar la
   tarea), léela antes de escribir y síguela. Un changelog no va a la papelera al cerrar una
   tarea: se queda ahí.
2. **La ruta exacta sale de `hebra_list_folders`.**
3. **Si la categoría no tiene `.05`**, no la crees: ni a mano (crear un ID es crear antes su nota
   del JDex) ni con `hebra_jd_new_id`, que da el siguiente ID de contenido y nunca un `.0x`.
   Díselo al usuario para que la cree en Hebra y deja el documento pendiente en la entrega, sin
   guardarlo en otro sitio.
4. **La `.05` está fuera del listado general.** El usuario la marca en la app con "Ocultar del
   listado general", que se hereda a todas sus subcarpetas: lo que hay dentro no sale en Notas,
   Hoy, Sin etiquetar ni Tareas nuevas, y sigue en la barra lateral y para el MCP. El MCP no
   puede poner esa marca en una carpeta (`hebra_set_hidden` es por nota), aunque las notas de
   dentro salen con `generalHidden: true`. Si el usuario dice que ve relevos o changelogs en el
   listado principal, pídele que marque así la `.05` de esa categoría.
5. **Las notas de decisiones de los agentes también van ahí.** La nota donde los agentes apuntan
   las decisiones y lo aprendido de un proyecto (por ejemplo `<Proyecto> - Decisiones y
   aprendizajes`) es memoria que el agente escribe para sí, no un informe para el usuario: va a
   la `.05` de la categoría aunque dure. Lo que dura y es para el usuario (audits, specs, planes
   y guías) va a la carpeta del ID del proyecto. Si las instrucciones del usuario fijan otra
   nota o carpeta para las decisiones, mandan ellas.

## Informes que pide el usuario: para una persona

Un audit, informe, análisis o lista de ideas que el usuario pide y que se guarda en Hebra se
escribe para que lo lea una persona que no estuvo en la conversación. No se escribe como una
nota de trabajo de un agente. No aplica a los relevos ni a los documentos efímeros del apartado
anterior, ni a los audits internos que un agente hace para sí mismo.

1. **Primero la conclusión**, en lenguaje llano. Cada término propio se explica la primera vez
   que sale.
2. **Tablas para comparar** opciones, hallazgos o ideas.
3. **Las referencias técnicas van a un anexo final**: rutas `fichero:línea`, SHA, ids y
   comandos. El cuerpo no las necesita para entenderse.
4. **Sin jerga de agentes** (gate, worktree, lote, estados de tareas) salvo que se explique.
