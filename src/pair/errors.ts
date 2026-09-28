/**
 * Fallos cerrados de `pair`/`unpair`. El `code` es lo único que va a stderr (SPEC.md §6.4);
 * el mensaje es para la terminal de David y nunca lleva códigos, tokens ni títulos.
 */
export type PairErrorCode =
  | 'invalid_lumbre_origin'
  | 'loopback_expired'
  | 'exchange_rejected'
  | 'exchange_failed'
  | 'account_mismatch'
  | 'account_unverified'
  | 'link_denied'
  | 'link_expired'
  | 'link_cancelled'
  | 'link_failed'
  | 'not_confirmed'
  | 'confirm_failed'
  | 'no_tty'
  | 'register_failed'
  | 'other_instance_running';

const MESSAGES: Record<PairErrorCode, string> = {
  invalid_lumbre_origin: 'El origen de Lumbre tiene que ser una URL https sin ruta (p. ej. https://app.lumbre.pro).',
  loopback_expired: 'Pasaron 5 minutos sin recibir el código de Lumbre. No se ha guardado nada: vuelve a lanzar «hebra-mcp pair».',
  exchange_rejected: 'Lumbre rechazó el código de emparejado (caducado, usado o no válido). No se ha guardado nada.',
  exchange_failed: 'No se pudo completar el canje con Lumbre. No se ha guardado nada.',
  account_mismatch: 'Esta cuenta de Lumbre no es la de la biblioteca ya vinculada en este equipo. No se ha guardado nada: entra con la cuenta de la biblioteca, o usa «hebra-mcp unpair» antes.',
  account_unverified: 'No se pudo comprobar que esta cuenta de Lumbre sea la de la biblioteca. No se ha guardado nada.',
  link_denied: 'Hebra denegó el acceso. No se ha guardado nada.',
  link_expired: 'La solicitud de acceso caducó sin respuesta. No se ha guardado nada.',
  link_cancelled: 'La solicitud de acceso se canceló. No se ha guardado nada.',
  link_failed: 'La solicitud de acceso falló. No se ha guardado nada.',
  not_confirmed: 'No has confirmado que sean tus notas. No se ha guardado nada y la solicitud se ha cancelado.',
  confirm_failed: 'No se pudo leer tu respuesta en la terminal (la entrada se cerró antes de confirmar). Ya se había creado una conexión de hebra-mcp en Lumbre: revócala en Lumbre > Integraciones > Hebra. No se ha guardado nada más en este equipo.',
  no_tty: 'pair necesita una terminal interactiva para confirmar que es tu biblioteca; ejecútalo en una terminal, no con el prefijo ! de Claude Code.',
  register_failed: 'El relé no aceptó el registro de este dispositivo. Los secretos quedan guardados: «hebra-mcp serve» lo reintenta al arrancar.',
  other_instance_running: 'Hay otra instancia de hebra-mcp en marcha sobre este directorio de datos. Cierra las sesiones de Claude que la usan y vuelve a intentarlo.'
};

export class PairError extends Error {
  /** Detalle cerrado adicional (un código del relé o un estado HTTP), nunca contenido. */
  constructor(
    readonly code: PairErrorCode,
    readonly detail?: string | number
  ) {
    super(MESSAGES[code]);
    this.name = 'PairError';
  }
}
