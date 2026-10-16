// =============================================================================
// lib/mv-refresh.ts — the §14 `mv_payment_weekly` refresh, in one place.
//
// The materialized view is refreshed from two callers with different
// contracts:
//   * jobs/execute.ts `mv:refresh` — the authoritative 5-minute cadence
//     (registry timing `{ kind: "interval", minutes: 5 }`), outside any
//     transaction because PostgreSQL refuses `REFRESH MATERIALIZED VIEW
//     CONCURRENTLY` inside a transaction block (D67);
//   * lib/payments.ts — a best-effort refresh right after an approval, so the
//     dashboard reflects the money without waiting for the tick. It is
//     deliberately swallowed on failure: a refresh problem must never fail a
//     review the reviewer just performed; the next tick is the retry.
//
// The statement carries BOTH test markers on purpose: the payments fake
// routes by `@pay:…` and the jobs fake by `@job:…`, and this one statement
// must stay assertable from both suites.
// =============================================================================

/** The narrow db surface the refresh needs (Prisma client satisfies it). */
export interface MvRefreshDb {
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/** `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_payment_weekly` (§14). */
export async function refreshPaymentWeekly(db: MvRefreshDb): Promise<void> {
  await db.$executeRaw`
    /* @pay:mv-refresh */
    /* @job:mv-refresh */
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_payment_weekly
  `;
}

/**
 * Best-effort variant for the approval path: the review already happened and
 * its result is final — a failed refresh is logged and left to the 5-minute
 * `mv:refresh` job. `warn` is injectable so tests pin the swallow without
 * spying on the console.
 */
export async function refreshPaymentWeeklyBestEffort(
  db: MvRefreshDb,
  warn: (message: string, error: unknown) => void = (message, error) => console.warn(message, error),
): Promise<void> {
  try {
    await refreshPaymentWeekly(db);
  } catch (error) {
    warn("[mv] payment weekly refresh failed", error);
  }
}
