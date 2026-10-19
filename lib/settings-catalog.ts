// =============================================================================
// §6 configuration catalog — the seed source of truth.
//
// The SQL migration (prisma/migrations/0001_init/migration.sql) creates the
// `settings` table EMPTY on purpose: DDL cannot depend on rows that only exist
// after the seed, so the catalog lives here in code and is written by
// prisma/seed.ts.
//
// Why this file is separate from the seed:
//   * prisma/seed.ts needs a live DATABASE_URL, this module needs nothing, so
//     tests/settings-catalog.test.ts can assert the catalog against the SQL
//     migration without a database (the seed<->migration drift gate).
//   * /admin/settings (F6) will need the same metadata (label, range, options)
//     to render the form, and it must not reach into a seed script for it.
//
// Every key below is transcribed from §6 "Catalogo de Configuracion (seed
// obligatorio)" of Especificacion-Sistema-Red-Referidos.pdf. `value` is a JSONB
// SCALAR (or an array for the one JSON-typed key): functions in the migration
// read them with `(s.value #>> '{}')::INTEGER`, which only works on scalars.
//
// Three values deviate from the literal §6 default; all are recorded in
// docs/decisiones.md and carry the reason in their `description`, so the
// deviation is visible from /admin/settings and auditable:
//   * referral.require_email_verification -> false (D7; this project ships no
//     mail stack, so there is nothing that could ever satisfy a verification)
//   * general.logo_key / support_email / terms_url -> "" (D7; §6 lists no
//     default and `settings.value` is NOT NULL; empty string is the "unset"
//     sentinel)
//   * visibility.member_sees_downline_amounts -> false (D39; §6 says true, the
//     F4 privacy contract keeps a downline offering amount invisible unless an
//     admin enables it; migration 0003 aligns databases seeded with true)
// =============================================================================

/** Mirrors the `setting_type` enum created by 0001_init. */
export type SettingType = "INT" | "DECIMAL" | "BOOL" | "STRING" | "ENUM" | "JSON";

/** Mirrors the `user_role` enum; `settings.editable_by` accepts ROOT|ADMIN|MEMBER. */
export type SettingEditableBy = "ROOT" | "ADMIN" | "MEMBER";

export interface CatalogEntry {
  /** Primary key, also the group prefix. Never rename without a migration. */
  key: string;
  type: SettingType;
  /** JSONB scalar (number | boolean | string) or array for type JSON. */
  value: number | boolean | string | number[];
  groupName: string;
  /** UI copy, Spanish (project convention: UI strings in es). */
  label: string;
  description: string;
  minValue?: number;
  maxValue?: number;
  /** Allowed values for type ENUM. */
  options?: string[];
  /** Readable without authentication. */
  isPublic: boolean;
  editableBy: SettingEditableBy;
}

export const SETTINGS_CATALOG: readonly CatalogEntry[] = [
  // --- Grupo: referral (§6) ---------------------------------------------------
  {
    key: "referral.max_direct_referrals",
    type: "INT",
    value: 12,
    groupName: "referral",
    label: "Referidos directos por persona",
    description: "Cupo de referidos directos por persona. El cambio se aplica de inmediato.",
    minValue: 1,
    maxValue: 1000,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "referral.max_depth",
    type: "INT",
    value: 0,
    groupName: "referral",
    label: "Profundidad máxima del árbol",
    description: "Niveles de referidos permitidos. 0 = sin límite.",
    minValue: 0,
    maxValue: 200,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "referral.count_pending_in_limit",
    type: "BOOL",
    value: true,
    groupName: "referral",
    label: "Contar invitaciones pendientes",
    description: "Las invitaciones sin usar ocupan un cupo.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "referral.invite_ttl_hours",
    type: "INT",
    value: 168,
    groupName: "referral",
    label: "Vigencia del enlace de un uso (horas)",
    description: "Tiempo para usar una invitación de un solo uso.",
    minValue: 1,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "referral.allow_multi_use_link",
    type: "BOOL",
    value: true,
    groupName: "referral",
    label: "Permitir enlace permanente",
    description: "Enlace permanente por usuario para invitar sin límite de usos.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "referral.auto_approve_registration",
    type: "BOOL",
    value: true,
    groupName: "referral",
    label: "Aprobar registros automáticamente",
    description:
      "Si se desactiva, la persona queda pendiente hasta que la apruebe su patrocinador o un administrador.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "referral.require_email_verification",
    // D7: §6 default is true; this project ships no mail provider (decision
    // "Quitar Resend"), so a true value would be unsatisfiable.
    type: "BOOL",
    value: false,
    groupName: "referral",
    label: "Exigir verificación de correo",
    description:
      "Este sistema no incluye proveedor de correo, así que la verificación no puede completarse. Se recomienda mantenerlo desactivado.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "referral.allow_sponsor_reassign",
    type: "BOOL",
    value: false,
    groupName: "referral",
    label: "Permitir reasignar patrocinador",
    description:
      "Habilita la operación administrativa para mover a una persona a otro patrocinador.",
    isPublic: false,
    editableBy: "ADMIN",
  },

  // --- Grupo: payments (§6) --------------------------------------------------
  {
    key: "payments.frequency",
    type: "ENUM",
    value: "WEEKLY",
    groupName: "payments",
    label: "Frecuencia del ciclo",
    description: "Cada cuánto se abre un nuevo ciclo de aportes.",
    options: ["WEEKLY", "BIWEEKLY", "MONTHLY"],
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.week_start_day",
    type: "INT",
    value: 1,
    groupName: "payments",
    label: "Día de inicio de la semana",
    description: "0 = domingo; 6 = sábado. Por defecto, 1 = lunes.",
    minValue: 0,
    maxValue: 6,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.grace_hours",
    type: "INT",
    value: 48,
    groupName: "payments",
    label: "Periodo de gracia (horas)",
    description: "Horas adicionales después del cierre de la semana para reportar.",
    minValue: 0,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.expected_amount",
    type: "DECIMAL",
    value: 10,
    groupName: "payments",
    label: "Monto esperado por ciclo",
    description: "Monto esperado por persona en cada ciclo.",
    minValue: 0,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.amount_mode",
    type: "ENUM",
    value: "MINIMUM",
    groupName: "payments",
    label: "Modo de monto",
    description:
      "Fijo: exige el monto exacto. Mínimo: exige al menos ese monto. Libre: acepta cualquier monto.",
    options: ["FIXED", "MINIMUM", "FREE"],
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.currency",
    type: "STRING",
    value: "USD",
    groupName: "payments",
    label: "Moneda",
    description: "Código internacional de la moneda de los aportes, por ejemplo USD.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.max_reports_per_cycle",
    type: "INT",
    value: 1,
    groupName: "payments",
    label: "Reportes máximos por ciclo",
    description: "Cantidad de aportes que cada persona puede enviar por ciclo.",
    minValue: 1,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.require_proof",
    type: "BOOL",
    value: false,
    groupName: "payments",
    label: "Exigir comprobante",
    description: "Solicita un comprobante en cada aporte.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.require_reference",
    type: "BOOL",
    value: true,
    groupName: "payments",
    label: "Exigir referencia",
    description: "Solicita la referencia del pago según el método elegido.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.allow_backdated_days",
    type: "INT",
    value: 7,
    groupName: "payments",
    label: "Días hacia atrás permitidos",
    description: "Cuántos días antes puede estar la fecha del pago.",
    minValue: 0,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.auto_approve",
    type: "BOOL",
    value: false,
    groupName: "payments",
    label: "Aprobar reportes automáticamente",
    description: "Si se activa, los aportes se aprueban al enviarse.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.exempt_root",
    type: "BOOL",
    value: false,
    groupName: "payments",
    label: "Eximir a la raíz",
    description: "Indica si la persona raíz queda exenta de reportar.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.reminder_days_before_due",
    type: "JSON",
    value: [1],
    groupName: "payments",
    label: "Días de aviso antes del vencimiento",
    description: "Días de aviso a quien aún no ha reportado.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.missed_grace_strikes",
    type: "INT",
    value: 3,
    groupName: "payments",
    label: "Ciclos incumplidos antes de suspender",
    description: "Número de ciclos incumplidos antes de suspender a la persona.",
    minValue: 0,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.auto_suspend_on_strikes",
    type: "BOOL",
    value: false,
    groupName: "payments",
    label: "Suspender automáticamente por incumplimientos",
    description:
      "Si se activa, la persona se suspende al alcanzar el número de ciclos incumplidos.",
    isPublic: false,
    editableBy: "ADMIN",
  },

  // --- Grupo: general (§6) ---------------------------------------------------
  {
    key: "general.app_name",
    type: "STRING",
    value: "Mi Red",
    groupName: "general",
    label: "Nombre de la aplicación",
    description: "Nombre visible de la marca. Se puede ver sin iniciar sesión.",
    isPublic: true,
    editableBy: "ADMIN",
  },
  {
    key: "general.timezone",
    type: "STRING",
    value: "America/Caracas",
    groupName: "general",
    label: "Zona horaria",
    description: "Zona horaria para calcular las semanas.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "general.locale",
    type: "ENUM",
    value: "es",
    groupName: "general",
    label: "Idioma",
    description: "Idioma de la interfaz. Por ahora solo está disponible el español.",
    options: ["es", "en"],
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "general.primary_color",
    type: "STRING",
    value: "#4F46E5",
    groupName: "general",
    label: "Color primario",
    description: "Color principal de la marca, por ejemplo #4F46E5.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "general.logo_key",
    type: "STRING",
    value: "",
    groupName: "general",
    label: "Clave del logo",
    description: "Identificador del logo guardado. Si está vacío, se usa el logo por defecto.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "general.support_email",
    type: "STRING",
    value: "",
    groupName: "general",
    label: "Correo de soporte",
    description: "Correo de soporte que se muestra a las personas. Si está vacío, no se muestra.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "general.terms_url",
    type: "STRING",
    value: "",
    groupName: "general",
    label: "URL de términos",
    description: "Enlace a los términos y condiciones. Si está vacío, no se muestra.",
    isPublic: false,
    editableBy: "ADMIN",
  },

  // --- Grupo: visibility (§6) ------------------------------------------------
  {
    key: "visibility.downline_depth_visible",
    type: "INT",
    value: 0,
    groupName: "visibility",
    label: "Niveles visibles hacia abajo",
    description:
      "Niveles de la red que puede ver un miembro. En esta versión solo se muestran sus referidos directos.",
    minValue: 0,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "visibility.member_sees_downline_payments",
    type: "BOOL",
    value: true,
    groupName: "visibility",
    label: "El miembro ve los aportes de su red",
    description:
      "Permite que un miembro vea si las personas de su red reportaron su aporte.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "visibility.member_sees_downline_amounts",
    // D39: §6 default is true; the F4 privacy contract hides the amount of a
    // downline offering unless an admin explicitly enables it. Migration 0003
    // flips databases seeded with the §6 default.
    type: "BOOL",
    value: false,
    groupName: "visibility",
    label: "El miembro ve los montos",
    description:
      "Si se desactiva, se ve que la persona aportó, pero no cuánto. El monto es un dato privado de quien lo reporta.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "visibility.member_sees_contact_data",
    type: "BOOL",
    value: true,
    groupName: "visibility",
    label: "El miembro ve datos de contacto",
    description: "Correo y teléfono de las personas de su red.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "visibility.mask_sensitive_fields",
    type: "BOOL",
    value: true,
    groupName: "visibility",
    label: "Enmascarar datos sensibles",
    description: "Oculta parcialmente la cédula y el teléfono al mostrarlos.",
    isPublic: false,
    editableBy: "ADMIN",
  },

  // --- Grupo: security (§6) --------------------------------------------------
  {
    key: "security.password_min_length",
    type: "INT",
    value: 8,
    groupName: "security",
    label: "Longitud mínima de contraseña",
    description: "Cantidad mínima de caracteres que debe tener una contraseña.",
    minValue: 8,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "security.require_2fa_for_admin",
    type: "BOOL",
    value: false,
    groupName: "security",
    label: "Exigir verificación en dos pasos a administradores",
    description: "Solicita un segundo paso de verificación al iniciar sesión.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "security.session_ttl_hours",
    type: "INT",
    value: 8,
    groupName: "security",
    label: "Duración de la sesión (horas)",
    // D17: the code clamps the effective lifetime at 8 h (SESSION_TTL_MAX_HOURS),
    // so the catalog offers exactly the range that can take effect.
    description: "Tiempo antes de volver a iniciar sesión. Máximo: 8 horas.",
    minValue: 1,
    maxValue: 8,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "security.login_rate_limit_per_15m",
    type: "INT",
    value: 10,
    groupName: "security",
    label: "Intentos de inicio de sesión por 15 minutos",
    // D18 counts FAILURES per account (a hash of the email), not per IP.
    description: "Intentos fallidos de inicio de sesión permitidos por cuenta cada 15 minutos.",
    minValue: 1,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "security.register_rate_limit_per_hour_per_ip",
    type: "INT",
    value: 5,
    groupName: "security",
    label: "Registros por hora e IP",
    description: "Registros permitidos por IP cada hora.",
    minValue: 1,
    isPublic: false,
    editableBy: "ADMIN",
  },
] as const;

/**
 * Settings the DDL itself depends on, so the seed can never omit one.
 *
 * 0001_init splits them in two kinds:
 *   * read at RUNTIME by a function — `fn_effective_max_referrals` reads
 *     `referral.max_direct_referrals`, `fn_user_move` reads `referral.max_depth`
 *     and `referral.count_pending_in_limit`. If the seed omits one, the function
 *     silently returns NULL and the rule degrades (a NULL quota = no limit).
 *   * baked into the DDL — the partial unique index `uq_report_user_cycle`
 *     exists precisely because `payments.max_reports_per_cycle` defaults to 1
 *     (D4). No function reads it, but raising it without a migration would
 *     leave the index contradicting the setting.
 *
 * tests/settings-catalog.test.ts re-derives this list from the migration text
 * (comments included, since the D4 dependency is documented there) so the
 * export can never fall out of sync with the SQL.
 */
export const SETTINGS_KEYS_READ_BY_SQL: readonly string[] = [
  "referral.max_direct_referrals",
  "referral.max_depth",
  "referral.count_pending_in_limit",
  "payments.max_reports_per_cycle",
];

/** Fast lookup used by the seed and by tests. */
export const SETTINGS_CATALOG_BY_KEY: ReadonlyMap<string, CatalogEntry> = new Map(
  SETTINGS_CATALOG.map((entry) => [entry.key, entry]),
);
