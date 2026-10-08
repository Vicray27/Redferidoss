# Red de Referidos — F1 Base (PR1: scaffold + compose)

Runnable foundation slice. Follow-up slices land as a stack: PR2 authoritative
`0001_init` SQL, PR3 Prisma 6 mirror, PR4 seed plus runtime libraries and gate.

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
