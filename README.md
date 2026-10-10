# Red de Referidos — F1 Base (PR1 scaffold · PR2 0001_init · PR3 schema.prisma)

Fundación ejecutable. Las entregas llegan apiladas: PR2 migración SQL
autoritativa `0001_init`, PR3 espejo Prisma (este), PR4 seed + librerías de
runtime + gate.

## Toolchain

- Node >= 20 (verificado en v24.20.0), pnpm vía `npm install -g pnpm` (el
  `corepack enable` requiere admin en Windows, por eso la instalación global
  por npm es el fallback soportado con el mismo resultado: `pnpm -v`).
- Docker NO es necesario en máquinas de desarrollo. Los contenedores corren
  en el servidor vía Portainer Stack (git + auto-update polling/webhook).
- `.env` es obligatorio para cualquier comando de Prisma (ver más abajo) y está
  en `.gitignore`.

## Verificación local (PR3, sin demonio)

```sh
pnpm install
cp .env.example .env      # Windows: Copy-Item .env.example .env
pnpm db:validate          # prisma validate
pnpm db:generate          # prisma generate -> cliente tipado
pnpm db:check:drift       # compara schema.prisma contra 0001_init (exit 1 si hay drift)
pnpm typecheck
```

`pnpm db:check:drift` es la red de seguridad de este slice: verifica enums,
tablas, columnas (nombre, tipo, nulabilidad), claves primarias e índices en
AMBAS direcciones, y exige que todo índice que solo existe en el SQL esté
listado en el bloque "Indexes NOT redeclared here" del schema.

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
`.next/static` y `public`). Por eso `pnpm db:migrate` dentro del contenedor
`app` NO funciona; la migración se aplica desde un contenedor desechable con
el repo montado y la red del stack.

```sh
# 1. En el host de Portainer, con el repo disponible (es público):
git clone https://github.com/Vicray27/Redferidoss.git /opt/red-referidos
cd /opt/red-referidos

# 2. Nombre de la red del stack (por defecto <stack>_default):
docker network ls | grep <stack>

# 3. Aplicar la migración (idempotente: `migrate deploy` no reaplica 0001):
docker run --rm -v "$PWD:/app" -w /app --network <red-del-stack> \
  -e DATABASE_URL="postgresql://referidos:<password>@postgres:5432/referidos?schema=public" \
  node:24-alpine sh -lc "corepack enable && pnpm install --no-frozen-lockfile && pnpm db:migrate"

# 4. Verificar (debe listar 17 tablas):
docker exec -it <contenedor-postgres> psql -U referidos -d referidos -c '\dt'
```

Solo para una base nueva (greenfield, sin datos de producción). Rollback:
borrar la base (o `docker compose down -v`) y volver a correr el gate desde un
checkout limpio. El arranque (`CMD ["node", "server.js"]`) nunca migra solo.

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
