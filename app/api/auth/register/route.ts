// =============================================================================
// app/api/auth/register/route.ts — the public self-registration endpoint (§8.3).
//
// A route handler, not a Server Action, because the caller has NO session yet:
// the register page is reached from a link, not from inside the portal, and
// the payload is a plain JSON body. What a Server Action would give us for free
// (Next's Origin/Host verification on every call) is done here explicitly with
// `assertSameOrigin`.
//
// On success the user is logged in on the spot: registering through a valid,
// unreserved invitation link IS proof the sponsor vouched for this person, so
// a second factor — a password they just chose — would add a step, not a
// control. When `referral.require_email_verification` is on, the account comes
// back PENDING and the portal shows the pending state instead of a session.
// =============================================================================

import { cookies } from "next/headers";

import { assertSameOrigin, clientIp, okResponse, parseJsonBody, withApi } from "@/lib/api";
import {
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  SESSION_TTL_SECONDS,
  signSessionToken,
} from "@/lib/auth/session";
import { registerCoreSchema } from "@/lib/register-schema";
import { registerUser } from "@/lib/registration";
import { registerThrottle, registrationDeps } from "@/lib/registration-deps";
import { RateLimitedError } from "@/lib/throttle";

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    assertSameOrigin(request);

    // Throttle BEFORE touching argon2 or the database: rejecting a flood must
    // be cheap (§13.3). Counting every attempt, not just failures — there is no
    // "failure" concept for this endpoint worth optimizing for.
    const ip = clientIp(request);
    const rate = registerThrottle.attempt(ip ?? "unknown");
    if (!rate.allowed) throw new RateLimitedError();

    const input = await parseJsonBody(request, registerCoreSchema);

    const result = await registerUser(
      input,
      { ip, userAgent: request.headers.get("user-agent") },
      registrationDeps,
    );

    // A PENDING account (email verification pending) may still log in to see
    // its state; the role gates what it can reach. Minting the cookie here is
    // what makes the "revisa tu correo" page reachable without a second login.
    const token = await signSessionToken({
      userId: result.userId,
      role: "MEMBER",
      publicCode: result.publicCode,
      fullName: result.fullName,
    });

    (await cookies()).set(SESSION_COOKIE, token, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: SESSION_TTL_SECONDS,
    });

    return okResponse(
      {
        user: {
          id: result.userId,
          publicCode: result.publicCode,
          fullName: result.fullName,
          status: result.status,
        },
        sponsorName: result.sponsorName,
        redirectTo: "/portal",
      },
      { status: 201 },
    );
  });
}
