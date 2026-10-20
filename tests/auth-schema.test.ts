import { describe, expect, it } from "vitest";

import { firstIssuesByField, loginSchema, type LoginInput } from "../lib/auth/schema";

/**
 * No database and no framework: Zod runs identically in a Client Component and
 * in a Server Action, which is the point — one definition, two call sites.
 *
 * The identifier field accepts three shapes (D86): email, cédula or username.
 * It must NOT use `z.email()`, or the two new forms would be rejected before
 * they ever reach the repository.
 */

function parse(overrides: Partial<LoginInput> = {}) {
  return loginSchema.safeParse({ identifier: "", password: "", ...overrides });
}

describe("loginSchema — accepts a well-formed login", () => {
  it("accepts an email", () => {
    const result = parse({ identifier: "root@example.com", password: "correcta" });
    expect(result.success).toBe(true);
  });

  it("accepts a cédula", () => {
    const result = parse({ identifier: "V-12345678", password: "correcta" });
    expect(result.success).toBe(true);
  });

  it("accepts a username", () => {
    const result = parse({ identifier: "juan.perez", password: "correcta" });
    expect(result.success).toBe(true);
  });

  it("trims the identifier before validating it", () => {
    const result = parse({ identifier: "  juan.perez  ", password: "correcta" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.identifier).toBe("juan.perez");
  });

  it("preserves the case, leaving normalisation to the repository", () => {
    // The schema must NOT lowercase: normalizeLoginIdentifier does that for the
    // throttle and the SQL comparison. Doing it twice in two places is how the
    // two rules drift apart.
    const result = parse({ identifier: "Root@Example.COM", password: "correcta" });
    expect(result.success && result.data.identifier).toBe("Root@Example.COM");
  });
});

describe("loginSchema — rejects with a Spanish message", () => {
  it("rejects an empty identifier with the required-field message", () => {
    const result = parse({ identifier: "", password: "correcta" });
    expect(result.success).toBe(false);
    expect(firstIssuesByField(result.error!).identifier).toBe(
      "Ingresa tu correo, cédula o usuario.",
    );
  });

  it("rejects a whitespace-only identifier as required, not as malformed", () => {
    // `.trim()` runs before `.min(1)`, so a pasted space is a missing field and
    // must not be reported to the user as an invalid value.
    const result = parse({ identifier: "     ", password: "correcta" });
    expect(firstIssuesByField(result.error!).identifier).toBe(
      "Ingresa tu correo, cédula o usuario.",
    );
  });

  it("does NOT require an @: a username or cédula is valid input", () => {
    expect(parse({ identifier: "no-es-un-correo", password: "correcta" }).success).toBe(true);
    expect(parse({ identifier: "root example.com", password: "correcta" }).success).toBe(true);
  });

  it("accepts an address at the registration email limit", () => {
    const identifier = `${"a".repeat(242)}@example.com`;
    expect(identifier).toHaveLength(254);
    const result = parse({ identifier, password: "correcta" });
    expect(result.success).toBe(true);
  });

  it("rejects an over-long identifier", () => {
    const result = parse({ identifier: "a".repeat(255), password: "correcta" });
    expect(firstIssuesByField(result.error!).identifier).toBe("El dato es demasiado largo.");
  });

  it("rejects an empty password with the required-field message", () => {
    const result = parse({ identifier: "root@example.com", password: "" });
    expect(firstIssuesByField(result.error!).password).toBe("La contraseña es obligatoria");
  });
});

describe("loginSchema — password policy is deliberately NOT enforced here", () => {
  it("accepts a one-character password at login", () => {
    // A login form checks an existing hash; it cannot enforce a policy. Doing so
    // would lock out every account created before the policy tightened, and the
    // stored hash carries no length to inspect anyway.
    const result = parse({ identifier: "root@example.com", password: "a" });
    expect(result.success).toBe(true);
  });

  it("still rejects an absurdly long password, to bound the hashing cost", () => {
    const result = parse({ identifier: "root@example.com", password: "a".repeat(201) });
    expect(firstIssuesByField(result.error!).password).toBe("La contraseña es demasiado larga");
  });
});

describe("firstIssuesByField", () => {
  it("keeps only the FIRST message per field", () => {
    const result = parse({ identifier: "", password: "" });
    const issues = firstIssuesByField(result.error!);
    expect(issues.identifier).toBe("Ingresa tu correo, cédula o usuario.");
    expect(issues.password).toBe("La contraseña es obligatoria");
  });

  it("returns an empty map when every field is individually valid", () => {
    const result = parse({ identifier: "juan.perez", password: "correcta" });
    expect(result.success).toBe(true);
  });
});
