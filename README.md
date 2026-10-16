# Red de Referidos — F1 Base (PR1 scaffold · PR2 0001_init · PR3 schema.prisma · PR4 seed + libs)

Fundación ejecutable. Las entregas llegan apiladas: PR2 migración SQL
autoritativa `0001_init`, PR3 espejo Prisma, PR4 seed + librería de settings +
helpers de árbol + contrato de cron (este).

## Toolchain

- Node >= 20 (verificado en v24.20.0), pnpm vía `npm install -g pnpm` (el
  `corepack enable` requiere admin en Windows, por eso la instalación global
  por npm es el fallback soportado con el mismo resultado: `pnpm -v`).
- Docker NO es necesario en máquinas de desarrollo. Los contenedores corren
  en el servidor vía Portainer Stack (git + auto-update polling/webhook).
- `.env` es obligatorio para cualquier comando de Prisma (ver más abajo) y está
  en `.gitignore`.

## Verificación local (PR4, sin demonio)

```sh
pnpm install
cp .env.example .env      # Windows: Copy-Item .env.example .env
pnpm db:validate          # prisma validate
pnpm db:generate          # prisma generate -> cliente tipado
pnpm db:check:drift       # compara schema.prisma contra 0001_init (exit 1 si hay drift)
pnpm typecheck            # tsc --noEmit
pnpm test                 # vitest run (47+ tests, sin base de datos)
```

`pnpm db:check:drift` es la red de seguridad del DDL: verifica enums,
tablas, columnas (nombre, tipo, nulabilidad), claves primarias e índices en
AMBAS direcciones, y exige que todo índice que solo existe en el SQL esté
listado en el bloque "Indexes NOT redeclared here" del schema.

`pnpm test` cubre el otro lado: `tests/settings-catalog.test.ts` deriva del
propio `migration.sql` qué settings lee el SQL en runtime y cuáles sólo
documenta el DDL, y falla si el seed no los siembra todos. Es el mismo
espíritu que el drift checker, aplicado a los datos en vez del esquema.

## Parámetros de negocio (§6, `lib/settings-catalog.ts`)

Los 40 parámetros de §6 viven en la tabla `settings` y se siembran con
`pnpm seed:root`. El código **nunca** los hardcodea: `lib/settings.ts` los lee
con caché de 60 s e invalidación `LISTEN/NOTIFY`, y una clave ausente lanza
`SettingsMissingError` en vez de devolver un default inventado.

```ts
import { getSettingOrThrow } from "@/lib/settings";

const quota = await getSettingOrThrow<number>("referral.max_direct_referrals");
```

`getSetting` devuelve `null` para una clave ausente (para las que sí son
opcionales, como `general.logo_key`); `getSettingOrThrow` es la que se usa
para todo paráetro del que el código depende.

## Variables de entorno

Además de `DATABASE_URL` y `TZ_DEFAULT`, el stack necesita:

| Variable | Para qué |
|---|---|
| `ROOT_EMAIL` | Correo del usuario raíz que crea `pnpm seed:root`. |
| `ROOT_PASSWORD` | Su contraseña. **Sólo para el seed inicial**; el seed aborta si falta. |
| `AUTH_SECRET` | **Requerida para que exista el login.** Firma la cookie de sesión (HS256). |
| `CRON_SECRET` | Protege `POST /api/cron/{job}`. Sin ella la ruta responde 503 (no se abre). |
| `UPLOADS_DIR` | Carpeta de comprobantes (default `./uploads`; en Docker `/app/uploads` con volumen propio, D42). |

### `AUTH_SECRET` es obligatoria y no tiene default

```sh
openssl rand -base64 32     # genera ~44 caracteres
```

La app **se niega a firmar sesiones** si `AUTH_SECRET` falta, tiene menos de 32
caracteres o sigue siendo el placeholder de `.env.example`
(`AuthSecretError`, D17). Es deliberado: un default silencioso firmaría sesiones
con una clave que está publicada en este repositorio, y cualquiera podría
forjar un token de ROOT. Un error ruidoso es el resultado correcto.

Se lee en **runtime**, no en build: Next.js inlinea los `process.env.FOO`
estáticos al compilar, y una acceso dinámico no se inlinea, así que la misma
imagen sirve para todos los entornos sin reconstruir.

## Autenticación (F2)

### Variables necesarias

Sólo `AUTH_SECRET`. `DATABASE_URL` ya hacía falta para todo lo demás.

### Flujo de login

1. `/login` valida el formulario con `react-hook-form` + Zod
   (`lib/auth/schema.ts`, mensajes en español).
2. El Server Action `loginAction` **vuelve a validar en el servidor** con el
   mismo esquema: la validación del cliente es una comodidad de UX, no un
   límite de confianza.
3. `lib/auth/login.ts` busca el usuario por email con `$queryRaw`
   parametrizado y `::citext` (`users.email` es CITEXT y Prisma no lo puede
   tipar, D14), y verifica la contraseña con Argon2id.
4. Si las credenciales son correctas, se firma un JWT (HS256, 8 h) y se guarda
   en la cookie `red_session`: `httpOnly`, `sameSite=lax`, `secure` en
   producción.
5. `middleware.ts` deja pasar `/admin` y `/portal` con sesión válida y
   redirige a `/login` sin ella. Cada página protegida **vuelve a comprobar**
   la sesión en el servidor (`lib/auth/require.ts`): el middleware redirige,
   no autoriza.
6. ROOT y ADMIN entran a `/admin`; el resto a `/portal`. Un `MEMBER` que pide
   `/admin` cae en `/portal`, no en `/login`.

### Recuperar o cambiar la contraseña del root

Si se pierde la contraseña del root **no hay correo de recuperación**: el
proyecto no tiene proveedor de correo (D7). El reset es una operación de
consola, deliberadamente explícita:

```sh
docker run --rm -v "$PWD:/app" -w /app --network <red-del-stack> \
  -e DATABASE_URL="postgresql://referidos:<password>@postgres:5432/referidos?schema=public" \
  -e AUTH_USER_EMAIL="victorjoseraymond@gmail.com" \
  -e AUTH_USER_PASSWORD='<nueva contraseña fuerte>' \
  node:24-alpine sh -lc "corepack enable && pnpm install --no-frozen-lockfile && pnpm auth:set-password"
```

Imprime cuántos usuarios coincidieron. Aborta si la contraseña falta o si el
correo no existe: no hay default, no hay generación automática y no hay
contraseña en el repositorio.

Las sesiones ya abiertas siguen siendo válidas hasta 8 h después del reset
(las sesiones son JWT sin estado; ver D17). Para que el cambio surta efecto de
inmediato, hay que cerrar sesión o reiniciar el contenedor `app`.

## Base de datos (PR2 DDL + PR3 espejo)

`prisma/migrations/0001_init/migration.sql` es la ÚNICA autoridad de DDL
(extensions ltree/pgcrypto/citext, 7 enums, 17 tablas, índices §5, EXCLUDE de
ciclos, triggers de árbol y `fn_user_move()`).

`prisma/schema.prisma` es su espejo exacto: mismos enums (tipos en minúsculas,
idénticos al SQL), mismas 17 tablas, mismos nombres de columna y tipos. Las
limitaciones de Prisma 6 se resuelven y documentan en el header del schema:

| SQL | Prisma |
|-----|--------|
| `CITEXT`, `LTREE` | `Unsupported("citext")` / `Unsupported("ltree")` |
| GiST / GIN / EXCLUDE / índices parciales | solo en SQL, listados en el schema |
| `DEFAULT now()`, `gen_random_uuid()` | `@default(dbgenerated(...))` |

`Unsupported` NO es consultable desde Prisma Client (queda fuera del modelo
generado): `users.email`, `users.path`, `invitations.email_target` y
`payment_reports.snapshot_path` requieren `$queryRaw`. **F2 resolvió el lookup
por email**: vive en `lib/users.ts` (`findByEmail`, `findByPublicCode`), siempre
parametrizado y con cast `::citext` explícito (D14). `insertUser` en
`lib/tree.ts` y `prisma/seed.ts` son raw por la misma razón.

**Nunca uses `prisma migrate dev`**: intentaría generar DDL desde el schema y
perdería ltree, GiST, EXCLUDE y los triggers. Solo `prisma migrate deploy`.

## Despliegue en el servidor (Portainer)

El stack corre la imagen *standalone* de Next.js: no incluye el CLI de Prisma
(`prisma` es devDependency y el runner solo copia `.next/standalone`,
`.next/static` y `public`). Por eso `pnpm db:migrate` y `pnpm seed:root` dentro
del contenedor `app` NO funcionan; se aplican desde un contenedor desechable
con el repo montado y la red del stack.

```sh
# 1. En el host de Portainer, con el repo disponible (es público):
git clone https://github.com/Vicray27/Redferidoss.git /opt/red-referidos
cd /opt/red-referidos

# 2. Nombre de la red del stack (por defecto <stack>_default):
docker network ls | grep <stack>

# 3. Migrar (aplica 0001_init y 0002_settings_notify; `migrate deploy` es
#    idempotente, volver a correrlo no reaplica nada):
docker run --rm -v "$PWD:/app" -w /app --network <red-del-stack> \
  -e DATABASE_URL="postgresql://referidos:<password>@postgres:5432/referidos?schema=public" \
  node:24-alpine sh -lc "corepack enable && pnpm install --no-frozen-lockfile && pnpm db:migrate"

# 4. Sembrar root + catálogo §6 + métodos + ciclo corriente.
#    Es idempotente: correrlo de nuevo no duplica nada.
docker run --rm -v "$PWD:/app" -w /app --network <red-del-stack> \
  -e DATABASE_URL="postgresql://referidos:<password>@postgres:5432/referidos?schema=public" \
  -e ROOT_EMAIL="root@example.com" \
  -e ROOT_PASSWORD='<contraseña fuerte, sólo para este seed>' \
  node:24-alpine sh -lc "corepack enable && pnpm install --no-frozen-lockfile && pnpm seed:root"

# 5. Verificar:
docker exec -it <contenedor-postgres> psql -U referidos -d referidos -c '\dt'          # 17 tablas
docker exec -it <contenedor-postgres> psql -U referidos -d referidos \
  -c 'SELECT count(*) FROM settings;'      # 40
docker exec -it <contenedor-postgres> psql -U referidos -d referidos \
  -c "SELECT public_code, path, depth FROM users WHERE sponsor_id IS NULL;"   # root, 0
```

Los pasos 3 y 4 pueden ir en un solo `docker run` (`&& pnpm db:migrate &&
pnpm seed:root`) si preferís una sola pasada.

La contraseña del root nunca se guarda en el repositorio: se pasa por
`-e ROOT_PASSWORD` y el seed **aborta** si no está, en vez de inventar una.

### Rollback

Solo para una base nueva (greenfield, sin datos de producción). Rollback:
borrar la base (o `docker compose down -v`) y volver a correr el gate desde un
checkout limpio. El arranque (`CMD ["node", "server.js"]`) nunca migra solo.

`0002_settings_notify` es **aditiva** a propósito: `prisma migrate deploy`
guarda el checksum de cada migración aplicada, así que editar `0001_init` en
una base que ya la aplicó la rompería. Si hay que deshacer PR4 en una base ya
sembrada, `DELETE FROM settings WHERE key LIKE 'referral.%'` etc. es preferible
a revertir la migración.

### Si la migración falla

| Síntoma | Causa | Qué hacer |
|---|---|---|
| `P1012 Environment variable not found: DATABASE_URL` | el contenedor no recibió la variable | repetir el paso 3 con `-e DATABASE_URL=...` |
| `P1001 Can't reach database server` | red equivocada o `postgres` no está healthy | `docker network ls`, esperar el healthcheck del stack |
| `permission denied to create extension "ltree"` | se conectó con un usuario sin superusuario | usar `POSTGRES_USER` (primer usuario del volumen, superusuario) |
| `P3005 database schema is not empty` | la base ya tiene objetos | base greenfield: `DROP DATABASE` y recrear, luego repetir |
| error de sintaxis SQL a mitad del archivo | el archivo se editó a mano | restaurar el SQL de git y repetir; Prisma ejecuta cada migración en una transacción, verificar antes de reintentar |

Diagnóstico rápido del estado aplicado:

```sql
SELECT migration_name, finished_at IS NOT NULL AS ok FROM _prisma_migrations;
```

### Si el seed falla

| Síntoma | Causa | Qué hacer |
|---|---|---|
| `ROOT_PASSWORD is required to run the seed` | falta la variable | repetir el paso 4 con `-e ROOT_PASSWORD=...` |
| `ROOT_ALREADY_EXISTS: only one root user is allowed` | ya había una raíz y el seed no la detectó | es el comportamiento esperado del trigger; el seed ya lo evita con su `SELECT` previo, si aparece es una doble ejecución concurrente |
| `SETTINGS_MISSING: the setting "…" does not exist` en runtime | la base no fue sembrada | correr `pnpm seed:root` (paso 4); el error es intencional, nunca hay default |
| `UNSUPPORTED_CYCLE_FREQUENCY` | alguien cambió `payments.frequency` a BIWEEKLY/MONTHLY | §6 no define el ancla para esas frecuencias (D12); volver a `WEEKLY` |

## Estructura del slice PR4

| Archivo | Qué hace |
|---|---|
| `lib/settings-catalog.ts` | Los 40 parámetros de §6 (datos puros, sin DB). |
| `lib/settings.ts` | Lector tipado: caché 60 s, invalidación LISTEN/NOTIFY, throw en clave ausente. |
| `prisma/seed.ts` | `pnpm seed:root` — root + catálogo + métodos + ciclo, idempotente. |
| `lib/cycles.ts` | Ventanas de ciclo en `general.timezone`, sin librería de fechas. |
| `lib/tree.ts` | Helpers de árbol: label ltree, derivación de path, `fn_user_move`, conteo por nivel. |
| `app/api/cron/[job]/route.ts` | Contrato `POST /api/cron/{job}`; 501 hasta F7. |
| `jobs/index.ts` | Registro de los 6 jobs de §9 (contrato, sin implementación). |
| `prisma/migrations/0002_settings_notify/` | Trigger que emite `settings_changed`. |

## Estructura de la autenticación (F2)

| Archivo | Qué hace |
|---|---|
| `lib/users.ts` | `findByEmail` / `findByPublicCode` sobre `$queryRaw` con `::citext` (D14). |
| `lib/auth/guards.ts` | Rol y ruta como funciones puras; `safeNextPath` anti open-redirect (D15). |
| `lib/auth/session.ts` | Token JWT HS256 con `jose`, Edge-safe; `AUTH_SECRET` en runtime (D16, D17). |
| `lib/auth/schema.ts` | `loginSchema` de Zod, compartido por cliente y servidor. |
| `lib/auth/login.ts` | `authenticate()` sin framework ni DB: sin enumeración y con igualación de tiempos. |
| `lib/auth/rate-limit.ts` | 8 fallos por 15 min sobre `rate_limits`, ventana fija, clave hasheada (D18). |
| `lib/auth/deps.ts` | Une `authenticate()` y el throttle con las implementaciones reales. |
| `lib/auth/actions.ts` | Server Actions `loginAction` / `logoutAction`. |
| `lib/auth/require.ts` | La autoridad de acceso en el servidor: `requireSession` / `requireStaffSession`. |
| `middleware.ts` | Redirige; no autoriza. Ver `lib/auth/require.ts`. |
| `app/login/` | Formulario (react-hook-form + Zod) y su página. |
| `app/admin/`, `app/portal/` | Zonas protegidas; identity visible, dashboard en F5. |
| `scripts/set-password.ts` | `pnpm auth:set-password`, el único reset de contraseña posible. |

## La red (F3)

Registro por invitación, panel de invitaciones y lecturas de red con recorte
por scope (§7.1). Los textos entre paréntesis son las secciones del documento
de referencia.

### Endpoints

| Método y ruta | Qué hace | Protección |
|---|---|---|
| `POST /api/auth/register` | Registro vía invitación (§8.3): valida, hashea fuera de la transacción, reválida bajo `FOR UPDATE`, crea usuario + obligación + auditoría, emite sesión. | `assertSameOrigin` + throttle por IP (20/h) |
| `GET /api/public/invite/[slug]` | Resuelve `/r/{code}` o `/invite/{token}`: patrocinador, cupos, campos del formulario. Sin `emailTarget`. | throttle por IP (60/10 min) |
| `GET /api/network/children` | Hijos directos paginados por keyset; `parentId` default = uno mismo. | `requireApiSession` + `assertCanViewUser` + `scopeFilter` |
| `GET /api/network/search` | Búsqueda por nombre o código dentro del alcance del actor. | ídem |
| `GET /api/network/nodes/[id]` | Ficha + breadcrumb; contacto y campos personalizados sólo staff o la propia persona. | ídem |

Todos responden el envelope de §10: `{ok:true,data}` o
`{ok:false,error:{code,message,details?}}`.

### Páginas y componentes

| Ruta / archivo | Qué hace |
|---|---|
| `/r/[code]`, `/invite/[token]` | Página pública de registro; invitación inválida o sin cupo muestra un error explícito, no un formulario. |
| `components/register/register-form.tsx` | Formulario: base con `registerCoreSchema` (misma definición que el servidor) + campos dinámicos. |
| `components/dynamic-form/` | `build-zod-schema.ts` (espejo cliente de las reglas del servidor) y `field-renderer.tsx`; los FILE se omiten (§8.3, D25). |
| `/portal` | Inicio: cupos, tamaño de red, referidos directos; la semana y los aportes viven en `/portal/semana` (F4a). |
| `/portal/network`, `/portal/network/[id]` | Árbol perezoso con búsqueda y ficha con subárbol, breadcrumb y campos personalizados. |
| `/portal/invitations` | Link permanente con QR, invitación de un solo uso, pendientes y revocar (Server Actions). |
| `components/network/network-tree.tsx` | Árbol colapsable; cada expansión es `GET /api/network/children`. |
| `components/link-box.tsx`, `components/qr-code.tsx` | Link absoluto + copiar + QR generado en el navegador (D34). |

### Librerías de la fase

| Archivo | Qué hace |
|---|---|
| `lib/invitations.ts` | Resolver ambos tipos de link, cupo (R3), emitir/revocar/consumir tokens; `@inv:*`. |
| `lib/registration.ts` | `registerUser()` con la carrera A3, R3/R4, campos dinámicos y auditoría; `@reg:*`. |
| `lib/registration-deps.ts` | Cableado real + los dos throttles de la fase. |
| `lib/invitations-actions.ts` | Server Actions de crear/revocar invitación (CSRF vía Next). |
| `lib/network.ts` | `listChildren`/`search`/`node`/`breadcrumb`/`subtreeSize`/`customValues`, todos con scope; `@net:*`. |
| `lib/api.ts` | `withApi`, `okResponse`, `parseJsonBody`, `parseQuery`, `assertSameOrigin`, `clientIp`. |
| `lib/throttle.ts` | Ventana fija por clave, reloj inyectable (D30). |
| `lib/register-schema.ts` | Contrato Zod del formulario, compartido cliente/servidor. |

### Verificación local

```sh
pnpm test        # 385+ tests de unidad, sin base de datos
pnpm typecheck
pnpm db:check:drift
```

Los tests de F3 cubren: cupo y consumo de invitaciones (con curas de reloj),
el espejo cliente de las reglas dinámicas, los helpers de API, y un invariante
que falla si alguna lectura de red viaja sin fragmento de scope para un
miembro. Las mitades de integración contra Postgres real quedan marcadas para
el servidor (igual que en fases anteriores). Las decisiones D19–D36 están en
`docs/decisiones.md`.

## La semana y los aportes (F4a)

Ciclos planificados, reporte semanal de la Visión Celular y el aporte de la
semana con revisión de staff (§5.5, §8.2, §8.5). La corrección de privacidad
D40 (el miembro ve sólo a sus referidos directos) aplica a todas las lecturas.

### Endpoints

| Método y ruta | Qué hace | Protección |
|---|---|---|
| `POST /api/uploads` | Sube un comprobante (multipart, campo `file`, ≤ 10 MB, JPG/PNG/WEBP/PDF por magic bytes) y devuelve `fileId`/`key` (D42). | sesión + `assertSameOrigin` + throttle 30/10 min por usuario |
| `GET /api/files/[key]` | Sirve un comprobante guardado en disco; sólo su dueño o staff (D45). | `requireApiSession` + dueño-o-staff + `Cache-Control: private, no-store` |
| `POST /api/cron/{job}` | `cycle:ensure` y `cycle:obligations` implementados; los otros 4 jobs siguen 501 (D41). | `CRON_SECRET` + mismo-origen |

Todos responden el envelope de §10.

### Páginas

| Ruta | Qué hace |
|---|---|
| `/portal/semana` | Reporte semanal (upsert hasta el cierre, D44), reporte de aporte con comprobante en dos pasos (D29/D42), historial propio y tablero "Visión Celular" con el alcance del actor. |
| `/admin/revisiones` | Cola de aportes pendientes: aprobar cumple la obligación y notifica; rechazar exige motivo (D43). |
| `/admin/configuracion` | Los 40 ajustes de §6 por grupo: sólo escribe lo que cambió, audita cada cambio y respeta `editable_by`. |

### Librerías de la fase

| Archivo | Qué hace |
|---|---|
| `lib/payments.ts` | Ventana `[starts_at, due_at)`, monto vs `expected_amount`, referencia/comprobante (D43), revisión y cumplimiento de `cycle_obligations`; `@pay:*`. |
| `lib/weekly-reports.ts` | UPSERT por `(user_id, cycle_id)` con validación de contadores y visitantes; `@weekly:*`. |
| `lib/settings-admin.ts` | Valida contra el catálogo, escribe `settings`, audita cada cambio e invalida la caché local; `@settings:*`. |
| `lib/storage.ts` / `lib/uploads.ts` | Guardado local en `UPLOADS_DIR`, sniffing de magic bytes y sha256. |
| `lib/payments-actions.ts`, `lib/weekly-actions.ts`, `lib/settings-actions.ts` | Server Actions de las tres pantallas: traducen `AppError` a mensajes y revalidan; ninguna regla vive ahí. |
| `jobs/execute.ts` | `cycle:ensure` (planifica 5 ventanas) y `cycle:obligations`, idempotentes por construcción (D41). |

### Verificación local

```sh
pnpm test        # 501 tests de unidad, sin base de datos
pnpm typecheck
pnpm db:check:drift
```

Las decisiones D37–D45 están en `docs/decisiones.md`.

## La planilla consolidada (F4b)

La lectura de conjunto del staff: una fila por persona con obligación, reporte
semanal u ofrenda en el ciclo (§8.4), con los totales derivados de las MISMAS
filas que se muestran, impresión A4 (el PDF sale del diálogo del navegador) y
exportación a Excel o CSV (D46, D47, D48).

### Endpoints

| Método y ruta | Qué hace | Protección |
|---|---|---|
| `GET /api/admin/reports/export?cycle=…&format=xlsx\|csv` | Descarga la planilla consolidada de esa semana: XLSX (write-excel-file, D47) o CSV RFC 4180 con BOM porque Excel lo necesita para leer acentos. `format` por defecto `xlsx`; nombre `planilla-<period_key>.<ext>`. | `requireApiSession` + guard staff del servicio (D39) + `Cache-Control: private, no-store` |

Al fallar responde el envelope de §10; al responder bien, el cuerpo es el archivo.

### Páginas

| Ruta | Qué hace |
|---|---|
| `/admin/reportes` | Planilla consolidada: selector de semana, tira de totales (personas, reportaron, no reportaron, asistieron, ofrendaron, montos, visitantes) y la matriz de 22 columnas de D46. Enlaces a impresión y a las dos exportaciones. |
| `/admin/reportes/imprimir?cycle=…` | Cara de papel: A4 apaisada, sin chrome de navegación, con sello "Generada el…"; el botón "Imprimir / Guardar PDF" abre el diálogo del navegador (D48). |

### Librerías de la fase

| Archivo | Qué hace |
|---|---|
| `lib/reports.ts` | `createReportsService` (solo staff): ciclos y planilla consolidada del ciclo; `SHEET_HEADERS` + `sheetMatrix` + `sheetCsv` son la única definición de las filas — pantalla, CSV, XLSX e impresión consumen esa matriz — y los totales se suman en céntimos BigInt sobre las mismas filas (`@reports:*`). |

### Verificación local

```sh
pnpm test        # 534 tests de unidad, sin base de datos
pnpm typecheck
pnpm db:check:drift
```

Las decisiones D46–D48 están en `docs/decisiones.md`.
