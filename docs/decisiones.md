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

### D16 — Sesión propia con `jose` (HS256) en vez de Auth.js v5
- Contexto: el stack nombra "Auth.js Credentials + Argon2id" (comentario de
  `lib/password.ts`), y F2 necesita credenciales + JWT httpOnly + guardas por
  rol en App Router.
- Evidencia (verificada contra el registro npm, no de memoria):
  - `next-auth` **`latest` = 4.24.15**; la v5 sigue en **`beta`** →
    `5.0.0-beta.32`. Es decir, v5 NO es estable: hace más de tres años que
    está en beta y `npm i next-auth` instala la v4, que no es la que el stack
    describe.
  - El despliegue es un stack de Portainer que reconstruye desde git cada 5
    minutos. Una dependencia en beta convierte cada bump transitivo en un
    riesgo operativo sobre el único activo que importa: poder entrar al
    sistema.
- Opciones: (a) `next-auth@5` beta con Credentials + JWT; (b) `next-auth@4`
  estable; (c) token JWT propio sobre `jose`.
- Decisión: **(c)**. El alcance real de esta fase es un solo método de
  autenticación (correo + contraseña), sin OAuth, sin proveedor de correo
  (D7), sin verificación de email y sin recuperación por email. Todo lo que
  Auth.js aporta por encima de eso —adaptadores de proveedores, base de datos
  de sesiones, callbacks, tipos de `Session`/`User`, capas de augmented types—
  es superficie que este proyecto no usa. A cambio, `lib/auth/session.ts` son
  ~180 líneas sin dependencia en beta, auditables de una sentada.
  Lo que SÍ se conserva de Auth.js: cookie httpOnly, `sameSite=lax`, JWT
  firmado, expiración, y una capa server-side que revalida en cada página
  protegida (`lib/auth/require.ts`).
- Consecuencias: se fija `algorithms: ["HS256"]` en la verificación (un token
  `alg: none` debe rechazarse) y se validan emisor y audiencia, para que un
  token emitido por otro servicio que comparta el secreto no sea aceptado. El
  payload se re-valida con Zod después de verificar la firma: la firma prueba
  que lo escribimos nosotros, no que el payload conserve la forma tras un
  cambio de esquema.
  **Costo asumido:** no hay `next-auth`, así que tampoco hay `signOut` de
  fábrica ni flujo de contraseña olvidada. El logout es un Server Action propio
  (`lib/auth/actions.ts`) y el reset se hace por consola con
  `pnpm auth:set-password` (README), que es la vía correcta cuando no hay
  correo saliente. Reevaluar si aparece un segundo proveedor (Google, Microsoft)
  o si el proyecto adopta la v5 estable.

### D17 — Sesión sin estado: la suspensión tarda hasta 8 h en aplicarse
- Contexto: un JWT no se puede revocar sin consultarlo. `users.status` puede
  pasar a `SUSPENDED` (o `deleted_at` a `now()`) mientras la sesión sigue viva.
- Decisión: JWT stateless con vida de **8 h**, cookie
  `httpOnly` + `sameSite=lax` + `secure` en producción. Un JWT robado tiene
  una vida acotada y conocida, que es la razón por la que la vida corta es
  obligatoria y no un detalle. El login **sí** respeta el estado
  (`SUSPENDED` se rechaza), y siempre después de verificar la contraseña, para
  que el mensaje específico no sirva de sonda de enumeración.
- Consecuencias y límite explícito: **suspender o borrar un usuario no invalida
  sus sesiones abiertas hasta que pasan 8 h como máximo.** Mitigaciones
  aceptables cuando haga falta:
  1. bajar `SESSION_TTL_SECONDS` (impacto directo en la experiencia de uso);
  2. denylist de `session_version` por usuario, verificada en
     `lib/auth/require.ts` (cuesta una lectura por página protegida);
  3. sesiones en base de datos, lo que deshace la statelessness.
  Ninguna se implementa ahora porque el modelo de amenazas de esta fase es el
  login, no la revocación inmediata. F5 es el corte natural para la opción 2.
- Nota de seguridad: `AUTH_SECRET` se lee en **runtime** y por clave
  dinámica. Next.js inlinea los `process.env.FOO` estáticamente analizables en
  tiempo de build, lo que ataría el secreto a la imagen Docker y obligaría a
  existirlo durante `docker build`; la documentación del framework indica que
  un acceso dinámico **no** se inlinea, que es justo lo que se necesita para
  promover una sola imagen entre entornos. Además `readAuthSecret()` **lanza**
  si falta, es corto o es el placeholder de `.env.example`: una sesión firmada
  con una clave pública del repositorio sería un root falso para cualquiera, y
  un default silencioso es el peor resultado posible.

### D18 — Throttle por fallos en login, con ventana fija y clave hasheada
- Contexto: `/login` es el único endpoint que acepta una contraseña. Sin
  límite de intentos, los hashes Argon2id quedan expuestos a un intento de
  adivinanza por fuerza bruta. La tabla `rate_limits` de §5.9 (PK compuesta
  `(key, window_start)`) ya existía en `0001_init` exactamente para esto.
- Decisión: 8 **fallos** por ventana de 15 minutos, en
  `lib/auth/rate-limit.ts`, comprobado **antes** de gastar tiempo de Argon2.
- Tres decisiones que no son obvias:
  - **Se cuentan los fallos, no los intentos.** Contar cada request permitiría
    que cualquiera bloqueara a un usuario conocido con unos pocos POST
    basura: un DoS contra una dirección que el atacante ya conoce. Contar
    fallos limita el ataque real. Quien se equivoca tres veces no llega al
    límite, y un login exitoso limpia el contador.
  - **La clave es `login:` + SHA-256(normalizado).** La tabla `rate_limits`
    no tiene semántica de propietario ni se muestra en ninguna pantalla:
    guardar ahí el correo en claro sería recolectar PII sin ningún beneficio.
  - **Ventana fija, no deslizante.** La PK compuesta `(key, window_start)`
    *es* una ventana fija por construcción; una deslizante exigiría otra forma
    de tabla y una migración nueva. El costo es que un atacante persistente
    puede repartir dos ráfagas sobre una frontera, aceptable con este límite.
- Consecuencias: el mensaje de límite (`RATE_LIMITED_MESSAGE`) no menciona ni
  correo ni contraseña, por la misma razón que `INVALID_CREDENTIALS_MESSAGE` no
  distingue "usuario inexistente" de "contraseña incorrecta": el throttle no
  puede convertirse en un oráculo de enumeración. El `DELETE` del `reset` sólo
  toca la ventana actual; las filas viejas se limpian en el job de F7.
- **Límite conocido y declarado:** es un throttle **por dirección de correo**,
  no por IP, así que un atacante puede repartir los intentos entre cuentas y,
  sobre todo, no frena un ataque contra **una sola cuenta** desde IP
  cambiantes. El límite por IP requiere leer `x-forwarded-for` detrás de un proxy
  y es trivial de evadir; el modelo de amenaza real de esta fase es la
  adivinanza de una credencial, que este diseño frena. Un límite combinado
  (cuenta + IP) es el siguiente paso natural si F5 expone un endpoint público
  de registro.
