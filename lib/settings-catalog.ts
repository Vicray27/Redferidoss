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
// Two values deviate from the literal §6 default; both are recorded in
// docs/decisiones.md (D7) and carry the reason in their `description`, so the
// deviation is visible from /admin/settings and auditable:
//   * referral.require_email_verification -> false (project ships no mail
//     stack, so there is nothing that could ever satisfy a verification)
//   * general.logo_key / support_email / terms_url -> "" (§6 lists no default
//     and `settings.value` is NOT NULL; empty string is the "unset" sentinel)
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
    description:
      "Cupo de referidos directos por persona. Cambiarlo a 10 debe surtir efecto inmediato, sin reiniciar.",
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
    label: "Profundidad maxima del arbol",
    description: "Profundidad maxima permitida. 0 = ilimitado.",
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
    description: "Las invitaciones sin consumir ocupan cupo.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "referral.invite_ttl_hours",
    type: "INT",
    value: 168,
    groupName: "referral",
    label: "Vigencia del enlace de un uso (horas)",
    description: "Vigencia del link de un uso.",
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
    description: "Link permanente por usuario.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "referral.auto_approve_registration",
    type: "BOOL",
    value: true,
    groupName: "referral",
    label: "Aprobar registros automaticamente",
    description:
      "Si es false, el nuevo usuario queda PENDING hasta la aprobacion del patrocinador o de un administrador.",
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
    label: "Exigir verificacion de correo",
    description:
      "§6 lo define en true. Este proyecto no incluye proveedor de correo, asi que se siembra en false; volver a true exige un proveedor de correo.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "referral.allow_sponsor_reassign",
    type: "BOOL",
    value: false,
    groupName: "referral",
    label: "Permitir reasignar patrocinador",
    description: "Habilita la operacion administrativa de la seccion 10.5 (fn_user_move).",
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
    description: "Frecuencia del ciclo de pagos.",
    options: ["WEEKLY", "BIWEEKLY", "MONTHLY"],
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.week_start_day",
    type: "INT",
    value: 1,
    groupName: "payments",
    label: "Dia de inicio de la semana",
    description: "0 = domingo ... 6 = sabado. Por defecto 1 = lunes.",
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
    description: "Plazo extra tras cerrar la semana (due_at = ends_at + grace_hours).",
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
    description: "Monto esperado por ciclo (NUMERIC(14,2) en la base, nunca float).",
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
      "FIXED exige el monto exacto; MINIMUM exige >=; FREE acepta cualquier monto.",
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
    description: "Codigo ISO de la moneda de los reportes.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.max_reports_per_cycle",
    type: "INT",
    value: 1,
    groupName: "payments",
    label: "Reportes maximos por ciclo",
    description:
      "Con el valor 1 el indice unico parcial uq_report_user_cycle aplica; subirlo exige una migracion que lo recree (D4).",
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
    description: "Comprobante obligatorio en cada reporte.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.require_reference",
    type: "BOOL",
    value: true,
    groupName: "payments",
    label: "Exigir referencia",
    description: "Referencia de pago obligatoria segun el metodo elegido.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.allow_backdated_days",
    type: "INT",
    value: 7,
    groupName: "payments",
    label: "Dias hacia atras permitidos",
    description: "Cuantos dias atras puede estar la fecha de pago (paid_at).",
    minValue: 0,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.auto_approve",
    type: "BOOL",
    value: false,
    groupName: "payments",
    label: "Aprobar reportes automaticamente",
    description: "Si es true, los reportes entran en APPROVED al enviarse.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.exempt_root",
    type: "BOOL",
    value: false,
    groupName: "payments",
    label: "Eximir a la raiz",
    description: "La raiz tambien reporta o no.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.reminder_days_before_due",
    type: "JSON",
    value: [1],
    groupName: "payments",
    label: "Dias de recordatorio antes del vencimiento",
    description: "Lista de dias (respecto a due_at) en los que se avisa a quien no ha reportado.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.missed_grace_strikes",
    type: "INT",
    value: 3,
    groupName: "payments",
    label: "Ciclos incumplidos antes de suspender",
    description: "Numero de ciclos incumplidos antes de pasar a SUSPENDED.",
    minValue: 0,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "payments.auto_suspend_on_strikes",
    type: "BOOL",
    value: false,
    groupName: "payments",
    label: "Suspender automaticamente por incumplimientos",
    description: "Si es true, al alcanzar missed_grace_strikes el usuario queda SUSPENDED.",
    isPublic: false,
    editableBy: "ADMIN",
  },

  // --- Grupo: general (§6) ---------------------------------------------------
  {
    key: "general.app_name",
    type: "STRING",
    value: "Mi Red",
    groupName: "general",
    label: "Nombre de la aplicacion",
    description: "Nombre visible de la marca. Se puede leer sin autenticacion.",
    isPublic: true,
    editableBy: "ADMIN",
  },
  {
    key: "general.timezone",
    type: "STRING",
    value: "America/Caracas",
    groupName: "general",
    label: "Zona horaria",
    description:
      "Zona horaria usada para calcular el ciclo. Nunca usar la del navegador para persistir (R11).",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "general.locale",
    type: "ENUM",
    value: "es",
    groupName: "general",
    label: "Idioma",
    description: "Idioma de la interfaz.",
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
    description: "Color primario de la marca, en hexadecimal.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "general.logo_key",
    type: "STRING",
    value: "",
    groupName: "general",
    label: "Clave del logo",
    description: "Clave del objeto en el almacen de archivos. Vacio = usar el logo por defecto.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "general.support_email",
    type: "STRING",
    value: "",
    groupName: "general",
    label: "Correo de soporte",
    description: "Correo de soporte publicado. Vacio = oculto.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "general.terms_url",
    type: "STRING",
    value: "",
    groupName: "general",
    label: "URL de terminos",
    description: "Enlace a los terminos y condiciones. Vacio = no mostrar.",
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
    description: "Cuantos niveles hacia abajo ve un miembro. 0 = ilimitado.",
    minValue: 0,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "visibility.member_sees_downline_payments",
    type: "BOOL",
    value: true,
    groupName: "visibility",
    label: "El miembro ve pagos de su red",
    description: "Un miembro ve los pagos de su red.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "visibility.member_sees_downline_amounts",
    type: "BOOL",
    value: true,
    groupName: "visibility",
    label: "El miembro ve los montos",
    description: "Si es false, ve el hecho del pago pero no el monto.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "visibility.member_sees_contact_data",
    type: "BOOL",
    value: true,
    groupName: "visibility",
    label: "El miembro ve datos de contacto",
    description: "Correo y telefono de su downline.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "visibility.mask_sensitive_fields",
    type: "BOOL",
    value: true,
    groupName: "visibility",
    label: "Enmascarar datos sensibles",
    description: "Enmascara cedula y telefono parcialmente.",
    isPublic: false,
    editableBy: "ADMIN",
  },

  // --- Grupo: security (§6) --------------------------------------------------
  {
    key: "security.password_min_length",
    type: "INT",
    value: 8,
    groupName: "security",
    label: "Longitud minima de contrasena",
    description: "Longitud minima exigida al establecer una contrasena.",
    minValue: 8,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "security.require_2fa_for_admin",
    type: "BOOL",
    value: false,
    groupName: "security",
    label: "Exigir 2FA a administradores",
    description: "Exige segundo factor para ROOT y ADMIN.",
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "security.session_ttl_hours",
    type: "INT",
    value: 720,
    groupName: "security",
    label: "Duracion de la sesion (horas)",
    description: "Validez de la sesion antes de exigir reautenticacion.",
    minValue: 1,
    isPublic: false,
    editableBy: "ADMIN",
  },
  {
    key: "security.login_rate_limit_per_15m",
    type: "INT",
    value: 10,
    groupName: "security",
    label: "Intentos de login por 15 minutos",
    description: "Intentos de inicio de sesion permitidos por IP cada 15 minutos.",
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
    description: "Altas de registro permitidas por IP cada hora.",
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