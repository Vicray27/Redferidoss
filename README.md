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
| `CRON_SECRET` | Protege `POST /api/cron/{job}`. Sin ella la ruta responde 503 (no se abre). |

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
`payment_reports.snapshot_path` requieren `$queryRaw` o una decisión de mapeo
posterior. Antes de F2 (auth) hay que resolver el lookup por email.

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
