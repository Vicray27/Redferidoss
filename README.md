# Red de Referidos — F1 Base (PR1: scaffold + compose · PR2: 0001_init)

Runnable foundation slice. Follow-up slices land as a stack: PR2 authoritative
`0001_init` SQL (this), PR3 Prisma 6 mirror, PR4 seed plus runtime libraries
and gate.

## Toolchain

- Node >= 20 (verified on v24.20.0), pnpm via `npm install -g pnpm` (corepack
  `enable` needs admin on Windows, so the npm-global install is the supported
  fallback with identical outcome: `pnpm -v`).
- Docker is NOT required on dev machines. Containers run on the server via
  Portainer Stack (git + auto-update polling/webhook).

## Local verification (PR1, no daemon)

```powershell
pnpm install
pnpm typecheck
# compose syntax is validated where docker exists; on this dev machine without
# a local daemon only static YAML checks run (see apply-progress).
```

## Server deploy (Portainer)

Portainer Stack points at this repo. On the server (docker available):

```sh
docker compose up -d
pnpm db:migrate   # wired from PR2 on (prisma/migrations/0001_init)
pnpm seed:root    # wired from PR4 on (prisma/seed.ts)
pnpm dev          # or the running app service on :3000
```

Copy `.env.example` to `.env` and replace every `change-me-*` placeholder.
`.env` is gitignored and never committed. F1 ships zero mail keys or deps
(no Resend, Nodemailer, SMTP) by design.

## Database (PR2: `prisma/migrations/0001_init`)

Authoritative hand-written SQL: extensions (ltree, pgcrypto, citext),
7 enums, 17 tables (§5 + Auth.js-standard sessions/verification_tokens/
password_resets), all §5 indexes (GiST path/snapshot_path, closure cover,
partial unique for `max_reports_per_cycle = 1`, EXCLUDE no-overlap on
cycles), plus `fn_user_tree_insert()` (BEFORE) + closure writer (AFTER) +
`fn_user_move()` (atomic, anti-cycle) + `fn_effective_max_referrals()`.
Closed decisions (image, ltree label, trigger split, partial unique,
national_id, insert-quota deferral): `docs/decisiones.md`.

Apply on the server (NOT yet — needs PR3's `prisma/schema.prisma`, the CLI
refuses to run without a datasource; pushing PR2 is safe, boot never
migrates automatically):

```sh
# Portainer → Stack console on the app service (DATABASE_URL set):
pnpm db:migrate   # prisma migrate deploy, greenfield only
```
