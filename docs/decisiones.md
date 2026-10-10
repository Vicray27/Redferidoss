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

## PR4 — seed + librería de settings

### D7 — Catálogo §6 completo: 40 claves, con dos desviaciones declaradas
- Contexto: `0001_init` crea la tabla `settings` VACÍA (el DDL no puede
  depender de filas que sólo existen tras el seed), así que el catálogo
  tiene que vivir en código. La spec §6 lo enumera en 5 grupos y en
  ningún artefacto previo de SDD estaba transcrito.
- Opciones: (a) sembrar solo las 4 claves que el SQL lee
  (`referral.max_direct_referrals`, `referral.max_depth`,
  `referral.count_pending_in_limit`, `payments.max_reports_per_cycle`);
  (b) sembrar las 40 claves de §6.
- Decisión: (b), en `lib/settings-catalog.ts`, con dos desviaciones
  explícitas respecto del literal de §6:
  - `referral.require_email_verification` se siembra **false**, no true.
    Este proyecto no tiene proveedor de correo (decisión "Quitar Resend"),
    así que un `true` sería un parámetro insatisfacible: nadie podría
    registrarse nunca. La fila lo dice en su `description` para que F2 lo
    revierta con un solo UPDATE cuando exista el proveedor.
  - `general.logo_key`, `general.support_email` y `general.terms_url` se
    siembran con `""`. §6 no les da default y `settings.value` es NOT
    NULL, así que la cadena vacía es el centinela de "sin configurar".
- Consecuencias: `tests/settings-catalog.test.ts` fija el catálogo contra
  el SQL (drift seed↔migración) y cuenta 40 claves, de modo que un borrado
  accidental falla en vez de reducir la superficie de parámetros en
  silencio.

### D8 — `is_public` y `editable_by` del catálogo
- Contexto: §5.7 define `is_public` ("si puede leerse sin autenticación,
  p. ej. nombre de la marca") y `editable_by` con default `ROOT` en el
  DDL, pero §6 dice "Todas editables desde /admin/settings" y no nombra
  qué claves son públicas.
- Decisión: `editable_by = ADMIN` en las 40 claves (con `ROOT` también
  autorizado, por jerarquía) — si se dejara el default `ROOT`, nadie con
  rol ADMIN podría editar nada desde `/admin/settings`, contradiciendo
  §6. `is_public = true` únicamente en `general.app_name`.
- Consecuencias: el resto de la marca (logo, color) queda detrás de
  autenticación hasta que F5/F6 lo pidan; cambiarla es un UPDATE, no una
  migración.

### D9 — `getSetting` devuelve null, `getSettingOrThrow` lanza
- Contexto: §6 pide "getSetting<T>(key), caché 60 s, NOTIFY" y el criterio
  "clave ausente = error explícito, sin default silencioso". El design
  (#216) propone las dos funciones.
- Decisión: `getSetting<T>(key): Promise<T | null>` devuelve `null` para una
  clave ausente y `getSettingOrThrow<T>(key): Promise<T>` lanza
  `SettingsMissingError` nombrando la clave. Las dos son explícitas: el
  tipo de `getSetting` obliga al llamador a decidir, y `getSettingOrThrow`
  es la que se usa para todo parámetro del que el código depende.
  **Sólo se cachean valores presentes**: una clave negativa no se cachea,
  para que `/admin/settings` la vea en la lectura siguiente y no después
  del TTL.
- Consecuencias: `lib/settings.ts` se construye con `createSettingsReader(
  loader)`, así que los 12 tests de caché/TTL/invalidación corren sin
  base de datos. La invalidación real llega por `pg` LISTEN sobre el canal
  `settings_changed`, emitido por el trigger de
  `prisma/migrations/0002_settings_notify` — una migración **aditiva**, no
  una edición de `0001_init`, porque `migrate deploy` guarda el checksum de
  cada migración aplicada y editar una ya aplicada rompe la base.

### D10 — Argon2id con `@node-rs/argon2`, no con `argon2`
- Contexto: el stack fijó Argon2id para Auth.js Credentials. La imagen de
  producción es `node:24-alpine`.
- Decisión: `@node-rs/argon2` (binarios N-API precompilados, incluido
  `@node-rs/argon2-linux-x64-musl`) en lugar de `argon2`, que exige
  node-gyp y un toolchain de compilación en alpine.
- Consecuencias: los parámetros (m=19456, t=2, p=1) viajan en el string
  PHC guardado, así que subirlos más adelante no invalida los hashes
  existentes. La contraseña del root sale SIEMPRE de `ROOT_PASSWORD`: el
  seed aborta si no está, porque una clave por defecto o generada en el
  repositorio sería una puerta trasera permanente.

### D11 — `public_code` del root derivado del correo
- Contexto: §5.1 pide un código corto legible de 8 caracteres en base32 sin
  ambigüedad, usado en `/r/{public_code}`. Un valor aleatorio haría el seed
  no reproducible; uno fijo y adivisible (`ROOT`) publica la URL de la raíz.
- Decisión: `derivePublicCode(email)` = SHA-256 del correo normalizado
  mapeado al alfabeto Crockford (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, sin
  I/L/O/U), primeros 8 caracteres.
- Consecuencias: estable entre entornos y re-ejecuciones, con la forma que
  §5.1 pide y sin que el código dependa del nombre del rol.

### D12 — Sólo `WEEKLY` es calculable: §6 no define el ancla de BIWEEKLY/MONTHLY
- Contexto: `payments.frequency` admite WEEKLY, BIWEEKLY y MONTHLY, pero el
  pseudocódigo de §9.1 ancla BIWEEKLY/MONTHLY a `payments.epoch_date`, y
  **no existe ninguna clave `epoch` en el catálogo §6**. Sin ancla no hay
  forma correcta de calcular la ventana.
- Decisión: `lib/cycles.ts` implementa WEEKLY y lanza
  `UnsupportedCycleFrequencyError` para las otras dos, con un mensaje que
  nombra la clave que falta. No se inventa un ancla: adivinar produciría
  ventanas desplazadas y ciclo solapado, que el EXCLUDE de §5.4
  rechazaría con un error incomprensible.
- Consecuencias: con el catálogo por defecto el seed nunca falla. Si un
  admin cambia la frecuencia antes de que exista el ancla, el error es
  explícito. La clave de ancla llega con el job `cycle:ensure` de F7.

### D13 — El cron acepta `Authorization: Bearer` y `x-cron-secret`
- Contexto: §9 dice literalmente "POST /api/cron/{job} con header
  `x-cron-secret`". `Authorization: Bearer` es la forma canónica y la que
  cualquier cliente (pg_cron vía HTTP, node-cron, curl) ya sabe construir.
- Decisión: `Authorization: Bearer <CRON_SECRET>` es la forma canónica y
  `x-cron-secret` se acepta también, por compatibilidad literal con §9. Si
  vienen ambos, manda `Authorization`. La comparación es de tiempo constante.
  **`CRON_SECRET` ausente responde 503, nunca "sin autenticación"**: un
  endpoint que se abre porque falta una variable es un disparador público de
  jobs.
- Consecuencias: la ruta valida el secreto ANTES de resolver `{job}`, así que
  un llamador sin credenciales no puede enumerar qué jobs existen. F7 elige
  cuál de las dos formas usa su scheduler sin tocar la ruta.

## F2 — autenticación real (login)

> La numeración arranca en D14: D8 y D9 ya estaban usados por F1.

### D14 — `users.email` (CITEXT) se lee con `$queryRaw`, no con un campo espejo
- Contexto: `users.email` es `CITEXT` y `prisma/schema.prisma` lo declara
  `Unsupported("citext")`. Prisma Client **excluye** los campos `Unsupported`
  del modelo generado, así que `findUnique({ where: { email } })` y
  `create({ data: { email } })` no compilan. Es la razón por la que F1 dejó el
  lookup "pendiente de resolver antes de F2" (ver el header de schema.prisma).
- Opciones: (a) `$queryRaw` parametrizado con cast `::citext` explícito;
  (b) agregar un campo `emailMirror String @db.Text` que Prisma sí pueda
  leer; (c) cambiar la columna a `TEXT`.
- Decisión: **(a)**. `lib/users.ts` centraliza los dos accesos necesarios
  (`findByEmail`, `findByPublicCode`) sobre `$queryRaw` etiquetado, así que
  todo valor viaja como parámetro de enlace y nunca concatenado. La
  comparación se normaliza en los dos lados: `normalizeEmail` en la app
  (`trim().toLowerCase()`, testeable sin base de datos) y `::citext` en SQL,
  de modo que el resultado no depende de que el llamador recuerde normalizar.
- Por qué no (b) ni (c): ambas hacen que Prisma tipifique la columna como
  `text`, y una columna `text` **pierde** la comparación insensible a mayúsculas
  que hace única `uq_users_email`. Un `emailMirror` además duplicaría el dato
  sin ninguna constraint que los mantuviera sincronizados. Se cambiaría un
  inconveniente conocido por un bug silencioso. `lib/tree.ts#insertUser` y
  `prisma/seed.ts` ya son raw por la misma razón; la regla es "CITEXT y LTREE
  se acceden por `$queryRaw`".
- Consecuencias: `AuthUserRow` (incluye `passwordHash`) es un tipo distinto
  de `ProfileUserRow`, y solo `findByEmail` lo devuelve, para que el hash no
  llegue por accidente a una página. `deleted_at IS NULL` se filtra en SQL, no
  en el llamador: un usuario borrado debe ser indistinguible de uno inexistente
  para que el login no sirva de enumerador de cuentas.

### D15 — Guardas de rol como funciones puras, y /admin no rebota a /login
- Contexto: spec pide que ROOT/ADMIN entren a `/admin` y el resto a `/portal`,
  con redirect a login si no hay sesión.
- Decisión: todo vive en `lib/auth/guards.ts` como funciones puras sin base de
  datos, sin cookies y sin imports de `next/*`. Eso las hace testeables de
  forma aislada **y** permite importarlas tanto desde `middleware.ts` (Edge
  Runtime) como desde un Server Component.
  Dos reglas que se fijan a propósito:
  - un `MEMBER` que pide `/admin` va a **`/portal`**, no a `/login`: está
    autenticado, mandarlo al login le diría falsamente que su sesión caducó;
  - `safeNextPath` rechaza `//host`, `/\host`, `https://…`, rutas relativas y
    `CR`/`LF`. Sin eso, `/login?next=//evil.example` convertiría un login
    exitoso en un robo de sesión vía open redirect.
- Consecuencias: el middleware es la **primera** compuerta, no la única.
  `lib/auth/require.ts` vuelve a comprobar en el servidor en cada página
  protegida, para que un error en el `matcher` no sea lo único entre una
  petición anónima y `/admin`. `toPathname()` recorta `?query` y `#fragment`
  antes de comparar: los predicados son comparaciones exactas o de prefijo, y
  `isAdminPath("/admin?tab=x")` sería `false` sin ese recorte, es decir, un
  bypass silencioso si alguien pasara `request.url` en vez de `pathname`.
