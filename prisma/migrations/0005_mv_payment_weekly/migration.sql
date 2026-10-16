-- =============================================================================
-- red-referidos — 0005_mv_payment_weekly (materialized view, no table change)
-- SDD slice F8.
--
-- §14: "Dashboard: vista materializada mv_payment_weekly(cycle_id, level,
-- method_id, status, total_amount, count) refrescada con REFRESH MATERIALIZED
-- VIEW CONCURRENTLY cada 5 min + al aprobar un pago."
--
-- Why a materialized view at all: the dashboard aggregates scan
-- `payment_reports` (the table §14 expects to grow to 1M rows). The MV folds
-- the money into (cycle, level, method, status) buckets once per refresh, so
-- the chart reads stop being proportional to the report count.
--
-- Why the unique index is load-bearing: `REFRESH MATERIALIZED VIEW
-- CONCURRENTLY` REQUIRES at least one UNIQUE index on plain columns; without
-- it PostgreSQL refuses the concurrent form and a plain REFRESH would lock
-- readers. (cycle_id, level, method_id, status) is the defining GROUP BY —
-- exactly one row per group by construction. `method_id` is nullable (a
-- report without an admin method catalog row); the unique index tolerates the
-- NULL group and `REFRESH ... CONCURRENTLY` compares rows null-safely.
--
-- Why the refresh is NOT wrapped in a transaction anywhere: PostgreSQL
-- rejects `REFRESH MATERIALIZED VIEW CONCURRENTLY` inside a transaction block.
-- That is why the `mv:refresh` job stays OUT of LOCKED_JOBS in jobs/execute.ts
-- (D41's transaction would break the very statement) and why the
-- approve-time best-effort refresh in lib/payments.ts runs after the review
-- statements, never inside the report's write transaction.
--
-- Why it ships WITH data: `CREATE MATERIALIZED VIEW ... AS SELECT` populates
-- on creation, so an environment that just ran `prisma migrate deploy` serves
-- correct dashboard numbers before the first scheduler tick. The trade the
-- spec accepts is bounded staleness: at most 5 minutes between refreshes.
--
-- Additive only: no table, column or index of existing models changes, so
-- `prisma migrate deploy` moves every environment forward and
-- `pnpm db:check:drift` is unaffected (the MV is not a Prisma model; the
-- unique index is listed in the schema header's SQL-only block).
-- =============================================================================

CREATE MATERIALIZED VIEW mv_payment_weekly AS
SELECT
  r.cycle_id,
  u.depth                                      AS level,
  r.method_id,
  r.status,
  SUM(r.amount)::numeric(14,2)                 AS total_amount,
  COUNT(*)::int                                AS "count"
FROM payment_reports r
JOIN users u ON u.id = r.user_id
GROUP BY r.cycle_id, u.depth, r.method_id, r.status;

-- The CONCURRENTLY requirement (§14); also the MV's identity for tooling.
CREATE UNIQUE INDEX uq_mv_payment_weekly
  ON mv_payment_weekly (cycle_id, level, method_id, status);
