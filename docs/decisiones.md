# Decisiones de diseño (registro vivo, una entrada por decisión cerrada)

Formato: contexto → opciones → decisión → consecuencias. Lo ambiguo se
resuelve hacia lo más configurable (spec §18.7).

## PR2 — migración 0001_init (F1 Base)

### D1 — Imagen Postgres con ltree (+ pg_cron a futuro)
- Contexto: compose necesita PG16 con ltree/pgcrypto/citext hoy y pg_cron
  en F7 (jobs). Spec §2/§5.
- Opciones: (a) stock `postgres:16`; (b) imagen con pg_cron incluido
  (p. ej. variantes supabase/timescale) desde ya.
- Decisión: (a) stock `postgres:16` pineado. ltree/pgcrypto/citext son
  módulos contrib incluidos en la imagen oficial. pg_cron NO viene en la
  imagen stock; su elección se difiere a F7, con fallback node-cron tras
  el mismo contrato `POST /api/cron/{job}` (design).
- Consecuencias: `prisma/migrations/0001_init` no usa pg_cron; ningún
  cambio de imagen antes de F7.

### D2 — Fuente del label ltree
- Contexto: el path es `root.<label>...`; el label debe ser válido ltree
  (empieza con letra) y derivarse de un identificador existente (tasks 2.3).
- Opciones: (a) `public_code` sanitizado; (b) uuid recortado.
- Decisión: (a) `fn_ltree_label(public_code)` = `'u_' || lower(code)` con
  todo `[^a-z0-9_]` → `_`. El prefijo `u_` garantiza inicio con letra
  aunque el base32 empiece con dígito, y nunca colisiona con `root`.
- Consecuencias: el trigger deriva path/depth/closure solo desde
  `sponsor_id` + `public_code`; el app nunca escribe path.

### D3 — Trigger AFTER INSERT (spec §4.1) partido en BEFORE + AFTER
- Contexto: spec pide trigger AFTER INSERT que calcule path + closure.
- Decisión: BEFORE asigna id/path/depth (AFTER no puede rellenar columnas
  NOT NULL de la fila insertada); AFTER inserta filas de closure (la fila
  users debe existir por las FKs). Misma garantía, dos triggers.
- Consecuencias: escritura directa de path/depth/sponsor_id rechazada por
  `fn_user_tree_guard()`; única vía de rewiring: `fn_user_move()`.

### D4 — Índice único parcial con max_reports_per_cycle = 1
- Contexto: R7 exige unicidad (user, cycle) solo cuando el setting vale 1.
- Decisión: el índice parcial `uq_report_user_cycle ... WHERE status <>
  'REJECTED'` se shippea para el default 1. Subir el setting requiere una
  migración que lo elimine/recree (el DDL no puede leer una fila de
  settings que solo existe tras el seed PR4).
- Consecuencias: documentado en el header de `migration.sql`.

### D5 — national_id condicional sin setting profile.*
- Contexto: §5.1 dice "único si profile.require_national_id", pero el
  catálogo §6 no define ningún grupo `profile.*`.
- Decisión: UNIQUE simple (los NULL no colisionan en Postgres):
  unicidad cuando hay valor, libre cuando es NULL.
- Consecuencias: si F6 introduce `profile.require_national_id`, se
  refuerza en capa app/seed, no en esta migración.

### D6 — Sin trigger de cupo en INSERT (R2) en PR2
- Contexto: R2 menciona constraint/trigger anti-carrera además de la
  transacción SERIALIZABLE.
- Decisión: no se añade. La prueba de concurrencia A3 vive en F2 con la
  transacción de registro + `tests/tree.test.ts` (PR4). El trigger BEFORE
  sí bloquea la fila del sponsor (`FOR UPDATE`) para serializar
  inserciones concurrentes bajo el mismo padre; `fn_user_move()` valida
  cupo + `max_depth` (§10.5).
- Consecuencias: F2 debe implementar la validación SERIALIZABLE de cupo
  en el registro; sin ella, el límite es best-effort a nivel app.
