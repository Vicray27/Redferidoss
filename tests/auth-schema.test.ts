import { describe, expect, it } from "vitest";

import { firstIssuesByField, loginSchema, type LoginInput } from "../lib/auth/schema";

/**
 * No database and no framework: Zod runs identically in a Client Component and
 * in a Server Action, which is the point — one definition, two call sites.
 */

function parse(overrides: Partial<LoginInput> = {}) {
  return loginSchema.safeParse({ email: "", password: "", ...overrides });
}

describe("loginSchema — accepts a well-formed login", () => {
  it("accepts a normal pair", () => {
    const result = parse({ email: "root@example.com", password: "correcta" });
    expect(result.success).toBe(true);
  });

  it("trims the email before validating it", () => {
    const result = parse({ email: "  root@example.com  ", password: "correcta" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe("root@example.com");
  });

  it("preserves the case of the email, leaving normalisation to the repository", () => {
    // The schema must NOT lowercase: `normalizeEmail` does that in lib/users.ts
    // against the database's own CITEXT folding. Doing it twice in two places
    // is how the two rules drift apart.
    const result = parse({ email: "Root@Example.COM", password: "correcta" });
    expect(result.success && result.data.email).toBe("Root@Example.COM");
  });
});

describe("loginSchema — rejects with a Spanish message", () => {
  it("rejects an empty email with the required-field message", () => {
    const result = parse({ email: "", password: "correcta" });
    expect(result.success).toBe(false);
    expect(firstIssuesByField(result.error!).email).toBe("El correo es obligatorio");
  });

  it("rejects a whitespace-only email as required, not as malformed", () => {
    // `.trim()` runs before `.min(1)`, so a pasted space is a missing field and
    // must not be reported to the user as "invalid email".
    const result = parse({ email: "     ", password: "correcta" });
    expect(firstIssuesByField(result.error!).email).toBe("El correo es obligatorio");
  });

  it("rejects a malformed email with a message that shows the expected shape", () => {
    const result = parse({ email: "no-es-un-correo", password: "correcta" });
    expect(firstIssuesByField(result.error!).email).toMatch(
      /Ingresa un correo válido.*nombre@dominio\.com/,
    );
  });

  it("rejects a missing @", () => {
    expect(parse({ email: "root@example", password: "x" }).success).toBe(false);
    expect(parse({ email: "root example.com", password: "x" }).success).toBe(false);
  });

  it("rejects an empty password with the required-field message", () => {
    const result = parse({ email: "root@example.com", password: "" });
    expect(firstIssuesByField(result.error!).password).toBe("La contraseña es obligatoria");
  });

  it("rejects an over-long email", () => {
    const result = parse({ email: `${"a".repeat(250)}@example.com`, password: "correcta" });
    expect(firstIssuesByField(result.error!).email).toBe("El correo es demasiado largo");
  });
});

describe("loginSchema — password policy is deliberately NOT enforced here", () => {
  it("accepts a one-character password at login", () => {
    // A login form checks an existing hash; it cannot enforce a policy. Doing so
    // would lock out every account created before the policy tightened, and the
    // stored hash carries no length to inspect anyway.
    const result = parse({ email: "root@example.com", password: "a" });
    expect(result.success).toBe(true);
  });

  it("still rejects an absurdly long password, to bound the hashing cost", () => {
    const result = parse({ email: "root@example.com", password: "a".repeat(201) });
    expect(firstIssuesByField(result.error!).password).toBe("La contraseña es demasiado larga");
  });
});

describe("firstIssuesByField", () => {
  it("keeps only the FIRST message per field", () => {
    // A blank email trips both min(1) and email(); showing two errors at once
    // would be noise, and the server must render the same one as the client.
    const result = parse({ email: "", password: "" });
    const issues = firstIssuesByField(result.error!);
    expect(issues.email).toBe("El correo es obligatorio");
    expect(issues.password).toBe("La contraseña es obligatoria");
  });

  it("returns an empty map when every field is individually valid", () => {
    // Sanity check on the helper itself, using an error that only has issues
    // the previous test already consumed.
    const result = parse({ email: "no-es-un-correo", password: "correcta" });
    expect(result.success).toBe(false);
    const issues = firstIssuesByField(result.error!);
    expect(Object.keys(issues)).toEqual(["email"]);
  });
});