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
//   AUTH_USER_IDENTIFIER=someone@example.com AUTH_USER_PASSWORD='<strong>' \
//     pnpm auth:set-password
//
// `AUTH_USER_IDENTIFIER` accepts the same three forms as the login form: email,
// cédula or username (D86). `AUTH_USER_EMAIL` is still read as a fallback so
// existing runbooks keep working; the new name wins when both are present.
// =============================================================================

import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { hashPassword } from "../lib/password";
import { createUserRepository } from "../lib/users";

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

/** New name first, legacy name second; never a default. */
function requireIdentifier(): string {
  const identifier = process.env.AUTH_USER_IDENTIFIER?.trim();
  if (identifier) return identifier;
  const legacy = process.env.AUTH_USER_EMAIL?.trim();
  if (legacy) return legacy;
  throw new Error(
    "AUTH_USER_IDENTIFIER is required (email, cédula or username). " +
      "AUTH_USER_EMAIL is still accepted for compatibility, but one of the two must be set.",
  );
}

export async function setPassword(client: PrismaClient = new PrismaClient()): Promise<number> {
  try {
    const identifier = requireIdentifier();
    const plain = requireEnv("AUTH_USER_PASSWORD");

    // Resolve first, so a typo fails before spending Argon2 time. The lookup
    // covers email, username and the normalised cédula (D86).
    const users = createUserRepository(client);
    const user = await users.findByIdentifier(identifier);
    if (!user) {
      throw new Error(
        `No user matched "${identifier}". Check the value; email and username are ` +
          `case-insensitive and the cédula is compared without spaces.`,
      );
    }

    // Argon2id, so the stored hash matches what hashPassword produced in the
    // seed. Reusing lib/password.ts is what guarantees the two can never drift
    // to different parameters.
    const passwordHash = await hashPassword(plain);

    // Update by primary key: the identifier was already resolved, and a second
    // match against CITEXT would reopen the ambiguity the lookup refused.
    const rows = await client.$queryRaw<Array<{ public_code: string }>>`
      UPDATE users
      SET password_hash = ${passwordHash}
      WHERE id = ${user.id}::uuid
        AND deleted_at IS NULL
      RETURNING public_code
    `;

    if (rows.length === 0) {
      throw new Error(
        `The user matched "${identifier}" but disappeared before the update.`,
      );
    }

    console.log(`· password updated for ${identifier} (public_code ${rows[0].public_code})`);
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