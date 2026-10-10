// =============================================================================
// scripts/set-password.ts — `pnpm auth:set-password`.
//
// The ONLY supported way to change a password after the initial seed.
//
// Why it is a script and not a page: the project has no mail provider (D7), so
// there is no "forgot my password" email to deliver a reset token through. A
// web form would either need an operator-only secret in the browser or would
// hand the reset to whoever can reach the URL. A console command on the server
// is the honest mechanism: whoever can run it already controls the container.
//
// It refuses to invent credentials. No default password, no generated-and-
// logged one, no password in the repository — the same rule the seed follows
// for ROOT_PASSWORD.
//
// Usage (server, container with the repo mounted — see README):
//   AUTH_USER_EMAIL=someone@example.com AUTH_USER_PASSWORD='<strong>' \
//     pnpm auth:set-password
// =============================================================================

import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { hashPassword } from "../lib/password";
import { normalizeEmail } from "../lib/users";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `${name} is required. It is intentionally not defaulted: a committed or ` +
        `generated password would be a permanent backdoor.`,
    );
  }
  return value;
}

export async function setPassword(client: PrismaClient = new PrismaClient()): Promise<number> {
  try {
    const email = normalizeEmail(requireEnv("AUTH_USER_EMAIL"));
    const plain = requireEnv("AUTH_USER_PASSWORD");

    // Argon2id, so the stored hash matches what hashPassword produced in the
    // seed. Reusing lib/password.ts is what guarantees the two can never drift
    // to different parameters.
    const passwordHash = await hashPassword(plain);

    // CITEXT, so this is a parameterised raw statement (D14). The lookup is
    // scoped to ACTIVE, non-deleted users: re-enabling a suspended account by
    // resetting its password would be a privilege escalation through a support
    // task.
    const rows = await client.$queryRaw<Array<{ id: string; public_code: string }>>`
      UPDATE users
      SET password_hash = ${passwordHash}
      WHERE email = ${email}::citext
        AND deleted_at IS NULL
      RETURNING id, public_code
    `;

    if (rows.length === 0) {
      throw new Error(
        `No user matched ${email}. Check the address and the spelling; ` +
          `it is matched case-insensitively against users.email.`,
      );
    }

    console.log(`· password updated for ${email} (public_code ${rows[0].public_code})`);
    console.log(
      "  sessions already issued stay valid for up to 8h: sessions are stateless " +
        "JWTs (D17). Restart the app container to invalidate them immediately.",
    );
    return rows.length;
  } finally {
    await client.$disconnect();
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  setPassword().catch((error: unknown) => {
    console.error("\nPassword update failed:");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}