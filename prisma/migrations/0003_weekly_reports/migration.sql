-- =============================================================================
-- red-referidos — 0003_weekly_reports (additive)
-- SDD slice F4a.
--
-- Two changes share one migration because both are pure additions the F4
-- scope needs:
--
-- 1. `weekly_reports` — the §8.4 self-service weekly report ("Visión
--    Celular"): one row per person per cycle. Attendance is marked by the
--    person themself (nobody marks for somebody else), so there is a single
--    row per (user, cycle) and no reviewer column. `visitors` carries the
--    still-unregistered visitors by name; JSONB because there is no visitor
--    identity to reference yet.
--
-- 2. `visibility.member_sees_downline_amounts` flips to false (D39): the F4
--    privacy contract says a member sees the FACT of a direct invitee's
--    offering but not the amount, unless an admin enables it. The seed
--    catalog already carries the new default; this UPDATE aligns databases
--    seeded earlier with the §6 default of true. `value` is JSONB, hence the
--    ::jsonb literals; the value guard avoids rewriting a row an admin
--    deliberately set after seeding.
--
-- Why a new migration instead of editing 0001_init:
--   `prisma migrate deploy` stores a checksum per applied migration. Editing
--   0001_init would break every database where it already ran. 0003 is purely
--   additive, so a database that already applied 0001/0002 moves forward
--   without recreating anything.
--
-- Covered by `pnpm db:check:drift`: since F4a the checker concatenates EVERY
-- migration (lexicographic order) before comparing against schema.prisma, so
-- the WeeklyReport mirror of this table is verified like any 0001 table.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. weekly_reports (§8.4) — one self-service report per person per cycle.
-- ---------------------------------------------------------------------------
CREATE TABLE weekly_reports (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  cycle_id              UUID        NOT NULL REFERENCES payment_cycles (id) ON DELETE RESTRICT,
  attended              BOOLEAN     NOT NULL DEFAULT FALSE,
  discipleship_attended BOOLEAN     NOT NULL DEFAULT FALSE,
  cells_total           INTEGER     NOT NULL DEFAULT 0,
  cells_held            INTEGER     NOT NULL DEFAULT 0,
  cells_not_held        INTEGER     NOT NULL DEFAULT 0,
  cell_attendees        INTEGER     NOT NULL DEFAULT 0,
  cell_absentees        INTEGER     NOT NULL DEFAULT 0,
  cell_new_visitors     INTEGER     NOT NULL DEFAULT 0,
  cell_new_cells        INTEGER     NOT NULL DEFAULT 0,
  visitors              JSONB       NOT NULL DEFAULT '[]',
  note                  TEXT        NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_weekly_reports_user_cycle UNIQUE (user_id, cycle_id)
);
COMMENT ON TABLE weekly_reports IS
  '§8.4 self-service weekly report: one row per person per cycle, written by the person themself.';

-- uq_weekly_reports_user_cycle already indexes (user_id, cycle_id); admin
-- aggregates read across users BY cycle, so cycle_id gets its own index.
CREATE INDEX idx_weekly_reports_cycle ON weekly_reports (cycle_id);

CREATE TRIGGER trg_weekly_reports_updated_at BEFORE UPDATE ON weekly_reports
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. D39 — offering amounts are private by default.
-- ---------------------------------------------------------------------------
UPDATE settings
   SET value = 'false'::jsonb
 WHERE key = 'visibility.member_sees_downline_amounts'
   AND value = 'true'::jsonb;
