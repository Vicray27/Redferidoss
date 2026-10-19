// =============================================================================
// lib/ui-labels.ts — presentation labels for raw codes rendered in the UI.
//
// The codes themselves (roles, statuses, catalog group names and enum options)
// are contractual: they live in the database, in SQL and in pinned tests. This
// module only translates them for people; it never rewrites the stored value.
// =============================================================================

/** `user_role` as the user-facing vocabulary already used by the session shell. */
export const ROLE_LABELS: Record<string, string> = {
  ROOT: "Administrador raíz",
  ADMIN: "Administrador",
  MEMBER: "Referido",
};

/** `user_status` for account/profile displays. */
export const USER_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Activo",
  PENDING: "Pendiente",
  SUSPENDED: "Suspendido",
};

/** `settings.group_name` values, in the order the settings screen shows them. */
export const SETTINGS_GROUP_LABELS: Record<string, string> = {
  general: "General",
  referral: "Referidos",
  payments: "Pagos y aportes",
  visibility: "Visibilidad",
  security: "Seguridad",
};

/** ENUM `settings` option codes that would otherwise render as raw English. */
export const SETTING_OPTION_LABELS: Record<string, string> = {
  WEEKLY: "Semanal",
  BIWEEKLY: "Quincenal",
  MONTHLY: "Mensual",
  FIXED: "Monto fijo",
  MINIMUM: "Monto mínimo",
  FREE: "Monto libre",
  es: "Español",
  en: "Inglés",
};

/** Fallback to the raw code keeps an unmapped future option readable. */
export function settingOptionLabel(option: string): string {
  return SETTING_OPTION_LABELS[option] ?? option;
}
