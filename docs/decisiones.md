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

## F3 - la red (invitaciones, registro, API y UI)

### D19 - Códigos públicos aleatorios para los miembros nuevos
- Contexto: D11 deriva el `public_code` del root de su correo. Para los
  miembros nuevos eso sería un fingerprint reversible del correo en un
  identificador que se comparte en links públicos.
- Decisión: `randomPublicCode()` genera 8 caracteres del alfabeto Crockford
  (sin I, L, O, U) con `randomBytes`, y se reintenta hasta 5 veces ante
  colisión (`uq_users_public_code`). El generador es inyectable para tests.
- Consecuencias: dos formatos conviven (el código del root derivado y los
  demás aleatorios); el resolver de invitaciones no distingue el origen, sólo
  el formato (`looksLikePublicCode`).

### D20 - Link permanente (sin fila) vs invitación de un solo uso (con fila)
- Contexto: §8.2 describe ambos, y R3 exige contar "invitaciones pendientes"
  contra el cupo.
- Decisión: el link `/r/{public_code}` no crea filas (el código ya existe);
  `/invite/{token}` inserta una fila en `invitations` con `uses`/`max_uses`.
  `quotaFor(userId, {excludeInvitationId})` permite que el registro consuma su
  propia invitación sin que ésta todavía cuente como pendiente: cupo
  aritméticamente correcto (hijo +1, pendiente −1). Todas las lecturas de cupo
  usan un CTE con orden de parámetros fijo.

### D21 - El hash de contraseña corre FUERA de la transacción
- Contexto: Argon2id tarda cientos de milisegundos; la transacción toma
  `FOR UPDATE` sobre el patrocinador (la decisión A3: dos registros
  simultáneos del último cupo, uno gana).
- Decisión: validación barata, hashing y generación de código público ocurren
  antes de `$transaction`; dentro sólo van las relecturas autoritativas y los
  INSERT. El lock no se sostiene mientras se calcula el hash.
- Consecuencias: el hash puede gastarse por un intento que luego falla por
  cupo; es el precio aceptable de no serializar el registro tras Argon2.

### D22 - Doble resolución de la invitación: antes y después del lock
- Decisión: `resolveInvite` se ejecuta una vez para identificar al
  patrocinador (a quién bloquear) y otra vez dentro de la transacción sobre la
  fila ya bloqueada (estado, expiración, cupo, R4 profundidad). La segunda es
  la autoritativa; la primera es sólo descubrimiento.
- Consecuencias: expiración y `revoked_at` se re-evalúan bajo lock; el envío
  de `emailTarget` no puede ser burlado por una carrera entre resolve y submit.

### D23 - `email_target`: la dirigida sólo se registra con ese correo
- Decisión: comparación case-insensitive; un correo distinto produce el mismo
  `RegistrationConflictError` genérico que un correo duplicado — el link
  público no puede usarse para un oráculo de direcciones.
- Consecuencias: el payload público de `/api/public/invite/[slug]` NO incluye
  `emailTarget` (menor divulgación); la coincidencia se explica en la UI de
  error sólo de forma genérica.

### D24 - Estado del nuevo usuario: ACTIVE o PENDING según settings
- Decisión: `ACTIVE` sólo si `referral.auto_approve_registration` está en
  true Y `referral.require_email_verification` en false (D7 no hay proveedor
  de correo: el seed lo deja en false). En cualquier otro caso `PENDING`.
- Consecuencias: el registro con PENDING igual emite sesión — la cuenta puede
  entrar a ver su estado; las guardas por rol deciden qué ve.

### D25 - Campos personalizados FILE se omiten por completo en el registro
- Contexto: §8.3 pide renderizar "todos" los custom_fields de registro, pero
  la subida de comprobantes llega con pagos (S3, F4).
- Decisión: FILE no se renderiza en el formulario y no puede ser obligatorio
  en el registro (`collectCustomValues` lo salta ANTES de evaluar `empty`); su
  valor se completa después. Sin esta excepción, un FILE obligatorio haría
  irregistrable a cualquier invitado.

### D26 - DECIMAL como string exacto y DATE con calendario estricto
- Decisión: DECIMAL se valida con `Number` pero se ALMACENA el string
  original (`NUMERIC` no debe pasar por float); DATE exige el formato
  AAAA-MM-DD y un round-trip ISO (`Date.parse("2026-02-31")` no devuelve NaN:
  rueda al 3 de marzo, así que el parse por sí solo no valida).

### D27 - La obligación del ciclo se crea sólo si existe un ciclo OPEN
- Decisión: al registrar, si hay un ciclo OPEN se inserta `cycle_obligations`
  con `expected_amount` = `payments.expected_amount`; si no hay ciclo, no se
  inventa una obligación (el siguiente ciclo lo tomará al recalcular).
- Consecuencias: `obligationCreated: false` viaja en el resultado; la UI de
  pagos (F4) no puede asumir que todo usuario del ciclo actual ya la tiene.

### D28 - Códigos de error y anti-enumeración en el registro
- Decisión: `INVITE_INVALID` (404, un único mensaje genérico; el motivo real
  — vencida/revocada/inexistente — sólo va al log), `REFERRAL_LIMIT_REACHED`
  (409, con el mensaje de "sin cupos"), `DEPTH_LIMIT_REACHED` (409),
  `REGISTRATION_CONFLICT` (409, genérico: correo duplicado y email_target no
  coincidente son indistinguibles).
- Consecuencias: la página pública de invitación tampoco distingue "no
  existe" de "revocada": mismo texto para ambas.

### D29 - Lecturas autenticadas como route handlers; mutaciones como Server Actions
- Decisión: `/api/network/{children,search,nodes/[id]}` son GET con
  `requireApiSession` (401 en envelope JSON, nunca redirect — un fetch no debe
  recibir HTML de login); crear/revocar invitación son Server Actions (Next
  verifica Origin/Host = CSRF gratis, como en F2); el registro público es un
  POST de route handler porque su cliente aún no tiene sesión, con
  `assertSameOrigin` explícito.
- Consecuencias: dos caminos de mutación conviven y la razón de cada uno está
  escrita en el archivo; mover una mutación de un mundo al otro es una
  decisión, no un detalle.

### D30 - Throttle en memoria para registro e invitación pública
- Contexto: el throttle de login (D18) es persistente por correo; el registro
  necesita un tope por IP que corte abuso scripted sin otra tabla.
- Decisión: `lib/throttle.ts` (ventana fija, contador por clave, reloj
  inyectable): 20 registros/hora/IP y 60 resoluciones/10 min/IP. Es
  process-local A PROPÓSITO, declarado en el archivo: este despliegue es un
  contenedor único; escalar horizontalmente exige un store compartido.
- Consecuencias: `clientIp` lee `x-forwarded-for` (primer hop) y es evadible
  por clientes directos; su trabajo es desalentar farmeos, no autenticar.

### D31 - Alias explícito del scope, y breadcrumb relativo para miembros
- Decisión: `scopeFilter(actor, {alias})` es obligatorio en cada consulta —
  `u` para children/search/node, `a` para breadcrumb (filtra ANCESTROS). Para
  un MEMBER el breadcrumb queda relativo a su subárbol (él → … → objetivo);
  para staff es la cadena completa raíz → objetivo. Mismo código, la decisión
  la toma el fragmento.
- Consecuencias: un test de invariante recorre los cuatro markers y falla si
  alguno viaja sin fragmento no vacío para un miembro.

### D32 - Qué revela la ficha de una persona
- Decisión: email/teléfono y campos personalizados sólo para staff o la
  propia persona (contact queda `null` y customValues `[]` — la página no
  decide, el servicio sí). El patrocinador se lee SIN filtro de scope: es el
  patrocinador de una fila ya autorizada, y para la propia fila es tu
  referente (por diseño). El "link de red" (`/r/{code}`) se muestra porque es
  público por naturaleza.
- Consecuencias: la excepción del sponsor es deliberada y está comentada en
  lib/network.ts; cualquier otro JOIN sin scope sería un bug.

### D33 - El portal F3: lo que muestra y lo que posterga
- Decisión: `/portal` (Inicio) muestra cupos disponibles, tamaño de la red y
  referidos directos; el estado de pago semanal de §8.4 queda para F4 con un
  placeholder explícito (mejor un cartel honesto que un número inventado).
  `/portal/network` trae árbol lazy + búsqueda; `/portal/network/[id]` la ficha
  con subárbol y breadcrumb; `/portal/invitations` el link permanente con QR,
  la creación de un solo uso, la lista de pendientes y revocar.
- Consecuencias: la vista Tabla con exportación (Vista tabla §8.4) y el botón
  "enviar por email" quedan anotados como pendientes de F5; el chip de estado
  de ciclo del árbol llega con los pagos.

### D34 - QR y links absolutos desde el navegador, sin APP_PUBLIC_URL
- Decisión: `components/link-box.tsx` compone la URL absoluta con
  `window.location.origin` tras el mount y `qrcode` genera data URLs en el
  cliente. El servidor nunca necesita saber su propio origen público.
- Consecuencias: el QR y el botón copiar siempre coinciden con el origen real
  (dev incluido); si en el futuro un email necesita links absolutos
  server-side, hará falta `APP_PUBLIC_URL` y ese es otro caso.

### D35 - Copy en español inline; next-intl sigue pendiente
- Contexto: §12 pide i18n vía next-intl con messages/es.json.
- Decisión: F3 mantiene la convención de F2 (copy español inline en los
  componentes); la capa i18n no se inventa a mitad de camino con un catálogo
  de dos frases. Cuando entre, entra una vez, sobre todos los textos.
- Consecuencias: deuda declarada, no silenciosa.

### D36 - El registro público vive fuera del matcher del middleware
- Decisión: el matcher sigue siendo `/admin`, `/portal` y `/login`: `/r`,
  `/invite` y `/api/public/*` deben ser alcanzables sin sesión, y el registro
  se protege con throttle + same-origin (D29/D30), no con una redirección.
- Consecuencias: un error futuro en el matcher degrada a "un redirect de más",
  nunca a "acceso anónimo a /admin" (la autoridad sigue siendo
  `requireSession` en cada página).

### D37 - Estado de ciclo derivado: OPEN/GRACE desde el reloj, CLOSED terminal
- Contexto: `payment_cycles.status` sólo necesita dos estados persistidos para
  los jobs (OPEN normal y CLOSED liquidado), pero la spec habla de ventana
  abierta, gracia y cierre.
- Decisión: `effectiveCycleStatus(row, now)` (lib/cycles.ts) deriva
  OPEN/GRACE/CLOSED del reloj — `[starts_at, ends_at)` es OPEN,
  `[ends_at, due_at)` es GRACE y `[due_at, ∞)` es CLOSED — sin scheduler; un
  CLOSED almacenado es TERMINAL y ningún cambio posterior de settings lo
  reabre. `isReportable` admite el reporte en `[starts_at, due_at)` y nunca
  sobre un CLOSED almacenado.
- Consecuencias: la etiqueta que ve el miembro no necesita cron; el job de
  liquidación (F7) sólo persistirá CLOSED y obligaciones MISSED cuando
  corresponda, y el reporte tardío deja de ser posible al vencer `due_at`.

### D38 - weekly_reports: una fila por persona y ciclo, contadores con default 0
- Decisión: la tabla `weekly_reports` (migración 0003) tiene
  `UNIQUE (user_id, cycle_id)`: la asistencia la marca la propia persona y
  nadie marca por otro, así que no hay múltiples filas ni columna de revisor.
  Siete contadores INTEGER con DEFAULT 0 (total, realizadas, no realizadas,
  presentes, ausentes, nuevos, células nuevas), `visitors` JSONB con los
  visitantes aún no registrados (por nombre, sin identidad referenciable
  todavía) y `note` libre. El servicio hace upsert mientras el ciclo sea
  reportable (D37); los rangos los valida el servicio, la tabla garantiza la
  forma.
- Consecuencias: los agregados administrativos leen por `cycle_id`
  (`idx_weekly_reports_cycle`); una fila con ceros significa "no hubo
  actividad", distinta de "no reportó" (sin fila), y F4b podrá contar ambas.

### D39 - Montos de la red ocultos por defecto (desviación de §6)
- Decisión: `visibility.member_sees_downline_amounts` se siembra en false
  (§6 dice true): un miembro ve el HECHO de la ofrenda de su referido directo
  pero no el monto, salvo que un admin lo habilite. La migración 0003 hace
  UPDATE de las filas ya sembradas en true; el catálogo ya trae el nuevo
  default.
- Consecuencias: el admin conserva el control (la clave sigue siendo
  editable); las lecturas de miembro deben exponer sólo el hecho (reporte
  cuyo status <> 'REJECTED'), nunca `amount` ni `reference`, cuando la clave
  esté en false.

### D40 - Un miembro ve solo a sus referidos directos (techo duro de la vista de red)
- Contexto: §6 expone `visibility.downline_depth_visible` ("0 = ilimitado") y
  F3 permitía al miembro navegar hasta el nivel configurado. La fase celular
  convierte la red en un circuito semanal: cada persona responde por su
  círculo directo, y no hay razón para que vea la estructura ni los
  contadores de subárboles ajenos.
- Decisión: `MEMBER_MAX_VISIBLE_DEPTH = 1` (lib/authz.ts): el valor
  configurado pasa por `narrowDepthCap` contra ese techo, así que puede
  ajustar por debajo pero nunca por encima — 0 ya no significa "ilimitado"
  para un miembro. En lib/network.ts `childrenCount` se fuerza a 0 fuera de
  la propia fila y `subtreeSize` corre bajo el mismo `scopeFilter`: cuenta
  solo los descendientes que el actor puede ver. La ficha de un referido
  directo (app/portal/network/[id]) oculta "Referidos directos", "Tamaño de
  su red", el link de red y el subárbol para el miembro; staff y la propia
  persona conservan la vista completa.
- Consecuencias: la página "sin acceso" de la ficha pasa a cubrir también el
  nivel 2 (antes el 403 recién llegaba en el nivel 4); el miembro deja de ver
  los links `/r/CODIGO` de terceros; "Tamaño de mi red" para un miembro pasa
  a significar sus referidos directos. El ajuste §6 queda conservado e
  inerte mientras el techo de F4 esté en 1.

### D41 - Idempotencia de los jobs de ciclos por construcción (sin advisory lock)
- Contexto: §9 pide jobs idempotentes y nombra `pg_try_advisory_lock`. Un
  advisory lock de sesión con Prisma exige fijar una conexión (una
  `$transaction` interactiva) que el pool sólo garantiza dentro del callback,
  y para estos dos jobs no aporta corrección: sus INSERT ya son seguros.
- Decisión: `cycle:ensure` inserta una ventana sólo si su período no existe y
  ninguna ventana existente se superpone (guard `NOT EXISTS` + `ON CONFLICT
  (period_key) DO NOTHING`), y trata la violación de la restricción de
  exclusión (`23P01`) como "perdió la carrera", no como error.
  `cycle:obligations` inserta con `ON CONFLICT (cycle_id, user_id) DO NOTHING`.
  Correr cualquiera de los dos dos veces es un no-op; el lock queda diferido a
  los jobs multi-statement de F7 (cycle:close, cycle:reminders), donde una
  sección crítica sí importa.
- Consecuencias: los jobs pueden dispararse por horario sin coordinación entre
  instancias; cada corrida responde su resumen (planned/created/skipped/raced)
  en el envelope §10 de `/api/cron/{job}`. `expected_amount` cruza a
  NUMERIC(14,2) siempre por el lado DECIMAL de lib/money.ts
  (`formatAmount(parseAmount(...))`), nunca como float (A14).

### D42 - Comprobantes en disco local durante F4 (desviación de §2/§10.4)
- Contexto: §2 y §10.4 especifican almacenamiento S3-compatible (MinIO) con
  URLs pre-firmadas; docker-compose define las variables S3_* pero el
  contenedor MinIO está deshabilitado (pull del registry bloqueado) y el
  servidor de la iglesia corre sólo app + Postgres. El circuito semanal no
  puede quedar bloqueado por un servicio de objetos que no existe en el
  despliegue.
- Decisión: `lib/storage.ts` implementa un driver de disco local detrás de
  tres métodos (`save`/`read`/`remove` por key) y `POST /api/uploads` — en vez
  de `/api/uploads/sign` — recibe el multipart directamente (≤10 MB,
  JPG/PNG/WEBP/PDF por magic bytes). La tabla `files` sigue siendo el registro
  y su `key` es agnóstica al backend: un driver S3/MinIO entra sin tocar a los
  llamadores. Los binarios viven en `UPLOADS_DIR` (default `./uploads`; volumen
  Docker `/app/uploads`) y nunca en la base.
- Consecuencias: sin URL pre-firmada la subida pasa por el servidor — más
  estricta (valida el contenido real, no el MIME declarado) y más lenta para
  archivos grandes; el endpoint va con throttle por usuario (30 cada 10 min).
  El flujo cliente es en dos pasos (subir → Server Action con `fileId`, D29)
  porque las Server Actions de Next limitan el cuerpo a 1 MB.

### D43 - Ventana del reporte semanal y composición de referencia/comprobante
- Contexto: §6 define `payments.require_reference` ("obligatoria según el
  método elegido") y `payments.require_proof` ("obligatorio en cada reporte"),
  mientras §5.6 da a cada método sus propios `requires_reference`/
  `requires_proof`. Faltaba decidir cómo se combinan los dos niveles y hasta
  cuándo se puede reportar (§8.4: un reporte por semana, con "corregir y
  reenviar" cuando el reporte está REJECTED).
- Decisión: la referencia exige AMBOS niveles (el setting global y el flag del
  método; apagar cualquiera de los dos la relaja, coherente con "según el
  método elegido"); el comprobante exige CUALQUIERA (un método puede pedirlo
  en solitario y el setting global lo impone a todos, coherente con
  "obligatorio en cada reporte"). La ventana de reporte es el ciclo que
  contiene a `now()` en `[starts_at, due_at)` (OPEN o GRACE): no hay reportes
  retroactivos después de `due_at`, y un reporte REJECTED sólo se puede
  reemplazar mientras esa ventana siga abierta. `paid_at` nunca puede ser
  futuro ni más viejo que `payments.allow_backdated_days` (días de calendario
  UTC completos).
- Consecuencias: un rechazo posterior a `due_at` ya no es corregible y el
  ciclo cuenta como incumplido (la UI de F4a ocultará "corregir y reenviar"
  cuando el ciclo cerró); el índice parcial `uq_report_user_cycle` (D4) queda
  como respaldo de "un reporte vivo por ciclo" y su violación se mapea a 409
  `REPORT_ALREADY_EXISTS`. El `code` de la tabla configurable `payment_methods`
  se proyecta al enum SQL `payment_method` por vocabulario (§5.5) con `OTHER`
  como fallback para métodos propios del admin.

### D44 - Vida del reporte semanal: upsert hasta el cierre (sin advisory lock)
- Contexto: §8.4 pide "un reporte por semana" auto-servicio, con contadores que
  la persona conoce mejor al final del ciclo; migración 0003 fija un único
  `uq_weekly_reports_user_cycle`. Faltaba decidir si el reporte semanal se
  escribe una sola vez o se puede corregir, y hasta cuándo.
- Decisión: `saveReport` es un UPSERT (`ON CONFLICT (user_id, cycle_id) DO
  UPDATE`) mientras el ciclo esté en su ventana `[starts_at, due_at)` (misma
  ventana que D43): la persona puede corregir sus números durante la semana y
  el reporte queda congelado al cerrar. Una sola sentencia ⇒ dos pestañas no
  pueden duplicar la fila y no hace falta advisory lock (doctrina de D41). Los
  contadores se validan en `[0, 9999]`, hasta 50 nombres de visitantes (≤120
  caracteres, trim) y nota ≤2000 caracteres; la lectura del downline
  reutiliza `scopeFilter` (alias `u`), así el techo de D40 aplica sin código
  propio.
- Consecuencias: el caso límite A6 (domingo 23:59) no requiere aritmética de
  timezone en el servicio — el ciclo que contiene a `now()` ya fue planificado
  con `week_start_day` y `general.timezone` en `cycle:ensure`; con ciclo
  cerrado y sin ciclos abiertos, `saveReport` responde 409
  `NO_REPORT_WINDOW`. La "Visión Celular" del líder (reunión propia +
  actividad de su gente directa) se compone con `myReports` +
  `downlineReports`, ambos filtrados por la misma capa de autorización.

### D45 - Los comprobantes se sirven por GET /api/files/[key] con autorización dueño-o-staff
- Contexto: los comprobantes viven fuera del web root (D42) precisamente porque
  pueden contener datos bancarios personales; pero el revisor necesita abrirlos
  desde `/admin/revisiones` para aprobar o rechazar con criterio. Sin una ruta
  de lectura, la revisión era a ciegas.
- Decisión: `GET /api/files/[key]` con sesión obligatoria; la fila de `files`
  decide quién puede leer: el dueño (`owner_id`) o cualquier rol staff
  (`ROOT`/`ADMIN`, vía `isStaffActor`). La clave se busca primero en `files`
  (sin fila ⇒ 404), así que ninguna ruta se arma con input crudo; el MIME sale
  de la fila y la respuesta viaja con `Content-Disposition: inline` y
  `Cache-Control: private, no-store`.
- Consecuencias: el staff audita sin copiar archivos a una carpeta pública y el
  rechazo de un miembro no puede venir de "no pude ver el comprobante". Un
  futuro almacenamiento S3 reemplaza solo esta ruta y `lib/storage.ts`; los
  tests de ruta existentes (`uploads-route`) marcan el patrón para cubrirla si
  hiciera falta.
- Adenda (F4b): un tercero recibe el MISMO 404 que una clave inexistente — la
  ruta nunca confirma que un archivo ajeno exista. El 403 queda para acciones
  sobre cosas visibles; aquí el objeto mismo no se acusa recibo. Cubierto por
  `tests/uploads-route.test.ts`.

### D46 - Planilla consolidada (§8.4): qué es una fila, qué suma cada total
- Contexto: §8.4 pide una "planilla consolidada" por ciclo (persona, nivel,
  reporte, contadores, ofrenda, estado) y §8.5 la reserva al staff. Faltaba
  fijar qué personas aparecen cuando los datos viven en tres tablas
  (`cycle_obligations`, `weekly_reports`, `payment_reports`) y cómo se cuentan
  los totales, sobre todo con la doble lectura del reporte semanal (D38): una
  fila reportada con todo en cero no puede contarse igual que una persona que
  nunca reportó.
- Decisión: la fila es toda persona viva (`deleted_at IS NULL`) con obligación
  O reporte semanal O reporte de pago en el ciclo — la unión es deliberada: una
  planilla jamás muestra dinero que pertenece a ninguna fila. Los estados de la
  columna "Reporte" son tres: "Reportó", "Sin actividad" (fila existe y todos
  los contadores/visitas están en cero, D38) y "No reportó" (no hay fila, D38).
  Los totales se derivan en JavaScript de las MISMAS filas que la tabla
  renderiza (una segunda consulta que sume aparte es un total que algún día
  discrepará de la tabla): `offered` = reportes de pago vivos (PENDING o
  APPROVED; un REJECTED no es ofrenda), `amountTotal` = suma exacta en céntimos
  BigInt (A14) de los montos vivos — siempre igual a la suma de las filas
  listadas — y `amountApproved` = solo los APPROVED. `visitors` suma los
  nombres de visitantes de las filas reportadas. La ofrenda elegida por fila es
  el reporte vivo si existe (a lo sumo uno por `uq_report_user_cycle`, D4) y,
  si no, el REJECTED más reciente, para que el descarte quede visible.
- Consecuencias: la pantalla, el CSV, el XLSX y la vista de impresión consumen
  la misma matriz de filas (`SHEET_HEADERS` + `sheetMatrix`), así que agregar
  una columna es una sola edición y las cuatro caras no pueden divergir. La
  ruta de exportación y la página comparten el servicio `createReportsService`
  (guard staff ANTES de cualquier lectura, D39) y el mismo nombre de archivo
  (`planilla-<period_key>.xlsx|csv`). La moneda de la tira de totales:
  `payments.currency` es un ajuste global (§6), así que un ciclo comparte moneda
  salvo que el admin la cambie a mitad de semana; la UI muestra la moneda
  cuando es única, «varias monedas» cuando no, y la columna Moneda por fila
  queda como detalle (`sharedCurrencyLabel`).

### D47 - El XLSX se genera con write-excel-file dentro del route handler
- Contexto: §8.4 pide exportar la planilla. Las opciones eran `exceljs`
  (arrastra un árbol de streaming grande para un caso de uso plano), `xlsx`
  (SheetJS, licencia y bundle de la edición community) y `write-excel-file`
  (declarativa: filas de celdas, sin dependencias nativas, un solo import
  `write-excel-file/node` para producir un Buffer en el servidor).
- Decisión: `write-excel-file@4.1.1` como única dependencia nueva del slice, y
  la generación vive en `app/api/admin/reports/export/route.ts` (runtime Node),
  consumiendo la MISMA matriz que la tabla (`sheetMatrix`): fila de encabezados
  en negrita, orientación apaisada y los anchos de `SHEET_COLUMN_WIDTHS`. El
  CSV no usa librería: son 8 líneas de RFC 4180 (comillas duplicadas, CRLF,
  BOM UTF-8) en `lib/reports.ts`, y una dependencia menos que actualizar. El
  nombre del archivo es `planilla-<period_key>.<ext>` y la respuesta viaja con
  `Cache-Control: private, no-store` porque lleva nombres y montos.
- Consecuencias: no existe una segunda definición de las columnas — agregar una
  pasa por `SHEET_HEADERS` + `sheetMatrix` + `SHEET_COLUMN_WIDTHS` y aparece en
  pantalla, CSV, XLSX e impresión a la vez. `format` por defecto es `xlsx`; un
  `format` desconocido responde 400 `VALIDATION_FAILED` antes de tocar la base.

### D48 - "Exportar a PDF" es la vista de impresión del navegador
- Contexto: §8.4 pide la planilla "exportable"; Excel sale por D47, y para PDF
  las opciones eran una librería (pdfkit/puppeteer: peso, fuentes y un segundo
  layout que mantener en sincronía) o la impresión del navegador.
- Decisión: la exportación a PDF es `GET /admin/reportes/imprimir?cycle=…` más
  `window.print()`: una página SIN `SessionShell` (el chrome de navegación no
  debe imprimirse), `@page { size: A4 landscape; margin: 10mm }`, encabezado
  con la semana, el rango de fechas y el sello "Generada el DD/MM/YYYY HH:MM", y
  la MISMA matriz que la pantalla y el XLSX; el único control interactivo es un
  botón cliente (`print-button.tsx`) que se oculta con `print:hidden`.
- Consecuencias: cero dependencias nuevas y una sola definición del documento,
  así que el PDF archivado es exactamente lo que se vio en pantalla; el sello de
  generación es lo que hace comparables dos impresiones de la misma semana. Un
  reporte semanal del portal (`app/portal/semana`) puede reutilizar esta vista
  más adelante sin agregar librería alguna.

### D49 - Gráficas §8.5: SVG determinista sin librería, geometría pura en lib/charts.ts
- Contexto: §8.5 pide cinco gráficas (barras por semana con ventana
  configurable, líneas reportes vs obligaciones, barras horizontales por nivel,
  Top 10 contribuyentes y patrocinadores, mapa de calor semanas × niveles).
  Las opciones eran una librería de charts (recharts/visx: cliente, peso en el
  bundle, hydration y un DOM que no se puede verificar sin navegador) o SVG
  servido por el servidor.
- Decisión: SVG generado en el servidor, sin dependencias y sin JavaScript de
  cliente; la matemática de escalas vive en `lib/charts.ts` como funciones puras
  (`niceMax`, `verticalBars`, `horizontalBars`, `linePoints`, `heatColor`,
  `percentLabel`, `resolveChartWindow`) que los tests fijan, y los componentes
  solo colocan los rects/polilíneas. La ventana temporal de las gráficas
  semanales es 12/26/52 ciclos (`CHART_WINDOWS`, default 12) anclada en el ciclo
  seleccionado (el seleccionado es el último punto), persistida en la URL como
  `semanas=`; un valor desconocido cae al default sin romper la página.
-   Consecuencias: los montos entran a la geometría como `number` solo para
  dibujar — el valor exacto que se imprime siempre sale de `lib/money.ts`; las
  gráficas se pueden testear sin DOM y se imprimen/exportan como HTML normal.
  Si una necesidad futura exige interacción (tooltips ricos, zoom), entra una
  librería en ese momento y solo para esa gráfica, no antes.

### D50 - KPIs §8.5: ocho tarjetas con semántica fijada y aritmética en centavos
- Contexto: §8.5 pide ocho tarjetas. "Ticket promedio", "tasa de cumplimiento",
  "usuarios nuevos" y "tamaño de la red" admiten varias lecturas (¿promedio de
  qué? ¿del periodo o histórico?), y una lectura implícita distinta en cada
  consulta es la forma más rápida de que dos personas vean cifras distintas.
- Decisión: todos los KPIs se anclan en la semana seleccionada (`?cycle=`,
  default la semana actual — misma convención que /admin/reportes, D37):
  1. Recaudado = Σ de montos APPROVED de la semana; 2. Nº de reportes = todos
  los reportes de la semana ("cuántos reportaron"); 3. Ticket promedio =
  recaudado / reportes aprobados, división entera de centavos con truncado hacia
  cero (nunca aparece una fracción de centavo); 4. Tasa de cumplimiento =
  aprobados / obligaciones, un ratio de pantalla (NO dinero); 5. Pendientes y
  6. Incumplidos = reportes PENDING y obligaciones MISSED de la semana;
  7. Usuarios nuevos = altas dentro de la ventana de la semana;
  8. Tamaño de la red = usuarios vivos, el único KPI independiente del periodo
  (la pregunta es del estado actual). El contexto del recaudado es la serie de
  barras por semana de la ventana elegida (`?semanas=`, D53) — no se calcula
  una media móvil aparte; un suavizado futuro sería una pregunta nueva, con su
  propia decisión.
- Consecuencias: cada número es reproducible desde la base sin decisiones
  ocultas; una tasa de cumplimiento sobre semanas viejas es exacta (la obligación
  es el denominador correcto, no las filas de usuario). `lib/dashboard.ts`
  documenta en su cabecera que la tasa es un ratio y no pasa por `lib/money.ts`.

### D51 - Tabla maestra §8.5: doce filtros normalizados, paginación real y una sola matriz de exportación
- Contexto: los doce filtros obligatorios llegan por la URL (compartible), pero
  una URL editada a mano no puede romper la página ni ensanchar la lectura; y
  la exportación (CSV/XLSX y "exportar selección") no puede convertirse en una
  segunda definición de columnas que se desincronice de la pantalla.
- Decisión: los filtros se normalizan en el servidor
  (`parsePaymentsFilters`): un valor mal formado se descarta — jamás toca SQL —
  un rango invertido se intercambia, la moneda sube a mayúsculas y los códigos
  se validan por forma (uuid, fecha UTC real, decimal ≤ 2 decimales, nivel
  0..99). "Subárbol de X" usa `snapshot_path` del reporte contra el `path`
  ACTUAL de X: responde "quién estaba bajo X cuando pagó", estable aunque el
  árbol se mueva. Los filtros de campos personalizados (`cf_<code>`) solo se
  aceptan para campos con `show_in_dashboard`. La tabla pagina server-side
  (`page`/`page_size`, default 50, máximo 200) con `ORDER BY reported_at DESC`.
  El CSV y el XLSX comparten `PAYMENTS_HEADERS + paymentsMatrix` (16 columnas
  fijas, estado en español, `-` para vacíos); la pantalla arma su propia tabla
  sobre los mismos datos. En ambos lados se suma UNA columna por campo de panel
  desde D57 — pantalla y exportación leen la misma lista de campos, así que no
  pueden desincronizarse. La exportación completa
  corta en 10 000 filas con un 400 explicativo en vez de truncar en silencio, y
  la exportación de selección valida y deduplica los ids con el mismo tope.
  La columna Usuario enlaza a la ficha de red (`/portal/network/<id>`, visible
  para staff), porque `/admin/usuarios` todavía no existe (F6).
- Consecuencias: los dos archivos salen de una única definición de
  fila/columna, y la pantalla —que renderiza a su manera— comparte con ellos la
  lista de campos dinámicos; una URL rota degrada a "menos filtros", nunca a un
  500 ni a una lectura más amplia; el nivel del reporte es el actual (`u.depth`)
  y el árbol de
  filtrado es el histórico (`snapshot_path`) — dos preguntas distintas con la
  columna que corresponde a cada una.

### D52 - Acciones en lote §8.5: aislamiento por ítem, tope de 500 y reasignación silenciosa
- Contexto: aprobar/rechazar en lote y reasignar ciclo sobre cientos de
  reportes exigen decidir qué pasa cuando UN ítem falla a mitad del lote, cómo
  se acota el trabajo y qué efectos de auditoría se replican.
- Decisión: `reviewMany` recorre los ids EN SECUENCIA y llama al MISMO
  `reviewOne` que la revisión individual: mismos campos de auditoría
  (`reviewed_by`/`reviewed_at`/`review_note`), misma sincronización de la
  obligación y misma notificación por ítem. Un ítem ya revisado (conflicto) o
  inexistente se OMITE con motivo y el lote continúa; un error de otro tipo
  aborta el lote (no se disfraza). El rechazo exige UNA razón compartida que se
  valida antes de tocar la base. Selección vacía o superior a 500 ids ⇒ 400 sin
  SQL. La reasignación mueve SOLO reportes PENDING (D4: un aprobado ya está
  atado a la obligación cumplida de su ciclo y no se reescribe; si la semana
  quedó mal, el camino auditable es rechazar y volver a reportar), valida que la
  semana destino exista y clasifica cada omisión: inexistente, no pendiente, ya
  está en la semana o duplicado en destino (violación del índice único
  parcial). No notifica: mover un reporte de semana no es una decisión sobre el
  dinero; la notificación sigue ocurriendo al revisar. El id mal formado se
  omite sin SQL, nunca llega a un cast `::uuid`.
- Consecuencias: un lote de 200 aportes deja 200 filas de auditoría idénticas a
  las de una revisión individual (nada "en bloque" invisible); el resultado
  siempre explica qué se omitió y por qué; y la integridad
  obligación↔reporte queda intacta porque solo se mueve lo que todavía no
  decidió nada. La aprobación posterior en la semana destino cumple la
  obligación de ESA semana por las reglas existentes, sin código nuevo.

### D53 - El panel `/admin` (F5): una sola vista raíz, gráficas servidas y estado en la URL
- Contexto: §8.5 pide que la Persona #1 vea "siempre y en detalle" toda la red.
  Las opciones eran repartir el resumen en varias pantallas nuevas o convertir
  `/admin` en el panel único con puertas; y para las cinco gráficas, interacción
  de cliente (D49 ya decidió SVG servido) contra un estado de selección que
  viva en la URL.
- Decisión: `/admin` ES el dashboard: ocho tarjetas KPI y las cinco gráficas en
  `components/charts/` (barras por semana, líneas reportes vs obligaciones,
  barras por nivel, Top 10 contribuyentes y patrocinadores, mapa de calor
  semanas × niveles) sobre la geometría pura de `lib/charts.ts`. La semana se
  elige con `?cycle=` y la ventana con `?semanas=` (12/26/52, default 12); ambos
  valores se validan en el servidor y un valor desconocido cae al default sin
  romper la página (el servicio re-valida `weeks` contra `DASHBOARD_WINDOWS`).
  Las gráficas reciben los montos en centavos solo para dibujar; las etiquetas
  que se imprimen salen de `lib/money.ts`. Una semana inexistente en la URL
  degrada a la semana vigente con aviso (misma doctrina que /admin/reportes) y
  "sin semanas" es un estado vacío, nunca un 500. Las cinco puertas (Pagos,
  Cumplimiento, Revisión, Reportes, Configuración) son tarjetas de navegación
  del encabezado; la portada del sitio ofrece el enlace a `/admin` únicamente a
  staff (`isStaffRole`). La tabla maestra vive en `/admin/pagos` con los doce
  filtros como parámetros GET — una vista filtrada es un enlace compartible —
  y la paginación y los enlaces de exportación re-serializan los filtros YA
  normalizados: la URL de la próxima página no arrastra basura. La exportación
  tiene dos puertas en una sola ruta (`/api/payments/export`): el conjunto
  filtrado o la selección por `ids`; cuando `ids` está presente los filtros se
  ignoran a propósito (exportar la selección exporta LA selección), y una
  selección que no parsea a ningún id es 400 — jamás un fallback silencioso al
  conjunto completo. El autocompletado de persona reutiliza
  `dashboard.searchUsers` detrás de `/api/payments/users` (solo staff,
  buscar-al-enviar: teclear no consulta).
- Consecuencias: el panel es una cara delgada sobre `createDashboardService` —
  la página no decide semántica de KPIs (§8.5/D50) ni aritmética de dinero, y
  todo dato nuevo pasa por el servicio con su marcador `@dash:*` y su test. Las
  gráficas siguen siendo verificables sin DOM porque la geometría vive en
  `lib/charts.ts` (D49); imprimir la pantalla imprime las gráficas como HTML.

### D54 - Cumplimiento (F5): cuatro estados sin ambigüedad, tope de 500 y drill-down a la tabla maestra
- Contexto: §8.5 pide la matriz persona × semana con verde/amarillo/rojo/gris y
  drill-down por persona. "Cumplimiento" admite estados que NO son
  incumplimiento (sin obligación, exenta) y una red grande puede volver la
  matriz impracticable; además, un drill-down como pantalla nueva duplicaría
  lectura, exportación y acciones que la tabla maestra ya tiene.
- Decisión: cuatro estados con semántica fija (`complianceState`, con D4 para
  la obligación): `approved` (algún reporte APPROVED), `pending` (reporte
  PENDING, u obligación que todavía debe), `missed` (solo un rechazo, u
  obligación MISSED), `exempt` (obligación EXEMPT o sin obligación). Las
  etiquetas viven en un solo mapa (`COMPLIANCE_STATE_LABELS`) para que leyenda,
  títulos de celda y cualquier vista futura usen las mismas palabras, y los
  colores reutilizan `heatColor` (D49): verde/ámbar/rojo/gris, el mismo idioma
  visual del mapa de calor del panel. La matriz corta en 500 personas
  (`COMPLIANCE_MAX_USERS`, detectado con cap+1) y AVISA del truncado en vez de
  presentar media red como la red entera; las ventanas son 4/12/26
  (`COMPLIANCE_WINDOWS`, default 12). Cada celda no exenta enlaza a la tabla
  maestra con filtros existentes: `/admin/pagos?userId=…&cycles=…`.
- Consecuencias: el drill-down hereda filtros, paginación, exportación y
  acciones en lote de la tabla maestra sin código nuevo; agregar un estado o
  cambiar una etiqueta toca un mapa y una función; y "gris" nunca se lee como
  incumplimiento porque la leyenda lo nombra.

### D55 - Métodos de pago configurables (F6): código inmutable, sin borrado y reordenamiento denso
- Contexto: §5.6/§8.5 piden que la administración gestione el catálogo de
  métodos (crear, editar, activar/desactivar, reordenar, instrucciones) sin
  romper nada de lo que ya depende de él: el formulario de la semana elige por
  id, `createReport` lee `requires_reference`/`requires_proof`, y la columna
  histórica `method` (ENUM) proyecta el código con el fallback OTHER (D43).
  Borrar un método referenciado es imposible (FK RESTRICT) y renombrar el
  código reescribiría la lectura de reportes viejos.
- Decisión: `lib/payment-methods-admin.ts` (solo ROOT/ADMIN; MEMBER recibe el
  403 genérico sin tocar SQL). El `code` se fija UNA vez al crear —trim,
  mayúsculas, 2..32 caracteres, letra inicial y luego letras/números/guion
  bajo— y jamás viaja en el payload de edición: `code` inmutable (D55). No hay
  delete: retirar un método es desactivarlo (`is_active = false`), y la API de
  §10.5 se queda en GET/POST/PATCH. El reordenamiento (↑/↓ en el panel)
  renumera DENSO la lista ordenada por `(sort_order, code)`: la columna no tiene
  unique y dos filas pueden compartir orden, así que un swap ingenuo de dos
  valores no movería nada en ese caso. Cada escritura aceptada deja UNA fila de
  `audit_log` con before/after (`payment_method.create|update|reorder`).
- Consecuencias: un método desactivado deja de ofrecerse en el formulario pero
  conserva su etiqueta en la revisión, la tabla maestra y la exportación (el
  reporte histórico nunca pierde su nombre); un código custom fuera del
  vocabulario del ENUM sigue funcionando por D43; y la pantalla de
  administración no puede tocar la base sin pasar por el servicio auditado.

### D56 - Campos personalizados configurables (F6): identidad congelada, sin borrado y un solo motor de validación
- Contexto: §8.5 pide el CRUD de campos personalizados "con previsualización
  del formulario". Los valores viven en `custom_field_values` con FK
  `ON DELETE CASCADE` a `custom_fields`, el código del campo es la clave del
  formulario (`raw[field.code]`) y el encabezado de exportación, y hasta ahora
  las reglas de validación vivían enterradas en `lib/registration.ts` (una
  segunda copia habría derivado). La tabla NO tiene unique sobre `value` (solo
  el GIN de búsquedas), así que `is_unique` no puede delegarse a la base.
- Decisión: un solo motor de validación server-side, `lib/custom-fields.ts`
  (`validateCustomValue`, `collectCustomValues`, `assertCustomValuesUnique`),
  del que dependen registro, administración y los formularios que vengan.
  `lib/custom-fields-admin.ts` (solo ROOT/ADMIN; MEMBER 403 genérico sin SQL)
  fija `entity`, `code` y `type` UNA vez al crear: la edición no los acepta
  —cambiar el tipo volvería ilegibles los valores históricos— y la salida es
  desactivar y crear otro. No hay delete: borrar arrastraría el CASCADE sobre
  datos de miembros; retirar es `is_active = false`. `default_value` es SOLO
  prefill del formulario (el servidor jamás inventa un valor) y se guarda en la
  forma canónica que el motor aceptaría (BOOL `"true"` → `true`, DECIMAL como
  texto exacto); en campos FILE se fuerza sin default y sin unique (un
  constraint sobre adjuntos opacos no significa nada). `visible_to` es el rol
  MÍNIMO que ve el campo en las vistas de lectura. `is_unique` se verifica en
  aplicación antes de insertar los valores (marker `@cf:unique-check`,
  excluyendo la propia entidad en re-ediciones): la carrera entre dos envíos
  simultáneos con el mismo valor queda documentada como aceptada — resolverla
  pediría un índice único funcional sobre el jsonb que hoy no existe. El
  reordenamiento renumera denso DENTRO de cada entidad, y cada escritura deja
  una fila de `audit_log` (`custom_field.create|update|reorder`). La pantalla
  de administración previsualiza cada campo con el MISMO renderer de los
  formularios (`FieldRenderer`).
- Consecuencias: registro y futuros formularios validan con las mismas reglas
  y los mismos mensajes (el prefill nunca puede contradecir a la validación);
  un campo desactivado desaparece de los formularios pero conserva sus valores;
  la unicidad es best-effort documentado en vez de una garantía de base; y la
  pantalla no puede escribir sin pasar por el servicio auditado.

### D57 - Campos personalizados en el aporte semanal (F6): transacción única, reenvío tras rechazo y valores en la revisión
- Contexto: conectar el motor D56 al formulario de aportes abre tres riesgos.
  Primero, el reporte y sus `custom_field_values` son UN solo dato: insertar el
  reporte y fallar después (o al revés) dejaría un envío sin sus datos o datos
  huérfanos. Segundo, `is_unique` es una verificación en aplicación (D56): si un
  rechazo se llevara por delante la historia, bloquear el MISMO valor en el
  reenvío convertiría la corrección en una prisión. Tercero, la revisión y la
  exportación deben leer valores etiquetados sin conocer cada campo.
- Decisión: `createReport` escribe el reporte y sus valores en UNA transacción
  interactiva (`PaymentsDb.$transaction`, con el tx estrecho `PaymentsTx` como
  superficie del callback — mismo patrón que `RegistrationTx`; Prisma lo
  satisface porque su cliente de transacción no expone `$transaction`). Las
  definiciones ACTIVAS de PAYMENT_REPORT se releen DENTRO de la transacción
  (marcador `@pay:custom-fields`): el cliente jamás dicta las reglas ni conoce
  un estado viejo de la página. El orden dentro de la transacción es: leer
  definiciones → `collectCustomValues` (ValidationError con `details` por
  campo) → INSERT del reporte → `assertCustomValuesUnique` con el id YA
  asignado → inserts de valores (`@pay:custom-value`); un choque único o un
  valor inválido revoca TODO el envío, nunca un reporte a medias. El chequeo de
  unicidad excluye los valores cuyo reporte quedó REJECTED (`NOT EXISTS` sobre
  `payment_reports.status`): un reporte rechazado es historia, y volver a
  enviar el mismo dato —el rechazo pudo ser por otro motivo— debe ser posible
  mientras la semana siga abierta (D43). El guard va por `field_id`, así que
  para campos de USER no puede coincidir jamás con una fila de reporte. El
  formulario de la semana prellena los defaults (D56), envía `custom` y pinta
  los `fieldErrors` que el servidor devuelve por campo; la cola de revisión
  agrega `label: valor` en la MISMA consulta con un `jsonb_agg` lateral
  ordenado por `sort_order, code`, y el formato de lectura vive en
  `formatCustomValue` (bool → Sí/No, listas → separadas por coma). La tabla
  maestra y ambas puertas de la exportación (conjunto filtrado y selección)
  comparten UN contrato de columnas: las 16 fijas de §8.5 más UNA por campo de
  panel (`show_in_dashboard` AND `is_active`), con la etiqueta del campo como
  encabezado y el valor formateado en la fila. Los valores viajan en la MISMA
  consulta de filas como un `jsonb_object_agg` lateral por `code` — el count de
  la paginación no lo carga — y la lista de campos se lee una vez por request,
  de modo que el archivo de la selección no puede llevar un encabezado distinto
  al de la tabla; retirar un campo del panel lo retira de las columnas sin
  tocar las filas. Los campos FILE siguen sin colectarse (D25).
- Consecuencias: un envío con datos personalizados es atómico —o queda entero o
  no queda—; rechazar y reenviar el mismo valor funciona y la persona ve por
  campo exactamente qué corregir; la revisión muestra los datos del aporte sin
  una segunda consulta ni conocer los campos; y agregar tipos de campo nuevos
  al formulario de aportes no toca `lib/payments.ts`, solo el motor compartido.

### D58 - F6 frente a §11 y §10.5: rutas en español, Server Actions y sin DELETE al retirar
- Contexto: §11 nombra las pantallas administrativas en inglés (`settings`,
  `custom-fields`, `payment-methods`) y §10.5 pide APIs REST
  (`GET/PUT /api/admin/settings`, el CRUD de `/api/admin/custom-fields` y
  `/api/admin/payment-methods`). La implementación de F6 siguió el patrón ya
  decidido en D29 —mutaciones por Server Actions con guard de staff, páginas
  RSC como cara— y nombres de ruta en español, consistentes con el resto del
  panel (`/admin/pagos`, `/admin/reportes`, `/admin/revisiones`).
- Decisión: (1) las rutas definitivas son `/admin/configuracion`,
  `/admin/campos-personalizados` y `/admin/metodos-pago`; la carpeta inglesa
  de §11 era un nombre, no un contrato; (2) las mutaciones viven en Server
  Actions (`lib/settings-actions.ts`, `lib/custom-fields-actions.ts`,
  `lib/payment-methods-actions.ts`) que ejecutan los MISMOS servicios con
  guard de staff y auditoría, y revalidan las rutas afectadas — NO se exponen
  las rutas REST de §10.5, porque un endpoint HTTP paralelo sería una segunda
  puerta de autorización que puede desincronizarse (D29); (3) tampoco hay
  DELETE en el retiro: desactivar es el fin de un campo (D56) o de un método
  (D55).
- Consecuencias: el contrato observable de la configurabilidad es la pantalla;
  si un consumidor externo necesita las APIs de §10.5, se agregan como fachadas
  delgadas sobre estos mismos servicios, con su propia decisión — no antes.

### D59 - Notificaciones in-app: la tabla 0001 estrena lector, y el recordatorio es solo in-app (F7)
- Contexto: la tabla `notifications` existe desde 0001 y su único escritor es la
  revisión de aportes (`payment.reviewed`); no había lector ni interfaz. §9 pide
  que `cycle:reminders` notifique "email + in-app". El proyecto no tiene
  proveedor de correo, y agregarlo exige una decisión propia (credenciales,
  rebotes, plantillas); el operador ve los avisos donde ya trabaja: la sesión.
- Decisión: (1) los avisos se leen SOLO in-app: badge en `SessionShell` (una
  consulta al índice parcial `idx_notifications_unread` por página autenticada)
  e inbox por rol — `/portal/notificaciones` para miembros y
  `/admin/notificaciones` para staff — con una bandeja compartida
  (`NotificationsInbox`) sobre el mismo servicio `lib/notifications.ts`. El
  correo queda como extensión futura del MISMO punto de escritura, no como
  requisito de la entrega. (2) La propiedad se impone en SQL: toda lectura y
  toda marca llevan `user_id = <sesión>`; un id ajeno afecta cero filas
  (`markRead` devuelve filas afectadas, no un booleano de fe). (3) "Marcar
  leída" es un POST de formulario a Server Actions idempotentes (guard
  `read_at IS NULL`): el inbox funciona sin JavaScript de cliente y reenviar el
  formulario no rompe nada. (4) El enlace del badge depende del rol
  (navegación, no autorización: cada página se guarda sola).
- Consecuencias: la persona y el staff ven los avisos sin salir de la sesión y
  sin un proveedor externo que mantener; el día que exista correo se agrega en
  el escritor (los jobs) sin tocar la bandeja; las filas históricas sin lector
  se vuelven visibles al primer render del inbox.
