-- =============================================================================
-- red-referidos — 0001_init (AUTHORITATIVE DDL, hand-written pure SQL)
-- SDD slice PR2. Prisma schema (PR3) mirrors this file; it NEVER generates
-- DDL for ltree / GiST / EXCLUDE / triggers. Source of truth: spec PDF §5.
--
-- Apply order on the server (Portainer Stack, polling git):
--   1. Merge PR3 first (it adds prisma/schema.prisma with the datasource;
--      `prisma migrate deploy` REQUIRES schema.prisma to run, so this file
--      alone is NOT yet applicable — pushing PR2 is safe, nothing auto-runs).
--   2. Open a console on the `app` service (or any shell with DATABASE_URL)
--      and run:  pnpm db:migrate   (= prisma migrate deploy)
--   3. Fresh DB only (greenfield, no prod data). Rollback: drop the database
--      (or `docker compose down -v`) and revert this file.
--      Boot (CMD ["node", "server.js"]) never runs migrations automatically.
--
-- Closed decisions (see docs/decisiones.md PR2):
--   D1 image: stock postgres:16 is enough (ltree/pgcrypto/citext are contrib
--      modules shipped in the image). pg_cron is NOT in stock postgres:16;
--      the pg_cron-capable image choice is deferred to F7 (jobs), per design
--      the fallback is node-cron behind the same POST /api/cron/{job} contract.
--   D2 ltree label = 'u_' || sanitized public_code (lowercase, [a-z0-9_];
--      'u_' prefix guarantees the ltree "starts with a letter" rule even when
--      the base32 code starts with a digit). Root label is 'root'.
--   D3 spec says "AFTER INSERT trigger fn_user_tree_insert()". Split in two:
--      BEFORE INSERT assigns id/path/depth (AFTER cannot fill NOT NULL
--      columns of the row being inserted); AFTER INSERT writes closure rows
--      (the users row must exist first for the closure FKs). Same guarantee.
--   D4 partial unique uq_report_user_cycle ships for the DEFAULT
--      payments.max_reports_per_cycle = 1. Raising that setting needs a
--      follow-up migration dropping/recreating the index (DDL cannot read
--      a setting row that only exists after the PR4 seed).
--   D5 users.national_id is plain UNIQUE (NULLs exempt in Postgres). The
--      conditional "profile.require_national_id" has no §6 catalog entry,
--      so there is nothing to branch on; uniqueness-when-present is the
--      closest spec-faithful rule.
--   D6 insert-time quota (R2 trigger) is NOT added here: quota races are
--      proven in F2 with the SERIALIZABLE register transaction + A3
--      concurrency test (tests/tree.test.ts lands in PR4). fn_user_move()
--      DOES validate quota + max_depth (§10.5 admin move).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions (§5: ltree, pgcrypto, citext)
-- NOTE: the first POSTGRES_USER of a fresh postgres:16 volume is superuser,
-- so CREATE EXTENSION works from `prisma migrate deploy` on the server.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- 1. Enums (§5.1, §5.3–§5.5, §5.7)
-- ---------------------------------------------------------------------------
DO $$ BEGIN CREATE TYPE user_role AS ENUM ('ROOT', 'ADMIN', 'MEMBER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE user_status AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE invite_kind AS ENUM ('SINGLE', 'MULTI');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE cycle_status AS ENUM ('OPEN', 'GRACE', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE report_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- payment_method enum (spec §5.5: kept as denormalised text history on the
-- report + method_id FK to payment_methods). Codes map to seed labels in PR4:
-- TRANSFER=Transferencia, MOBILE=Pago movil, ZELLE=Zelle, CASH=Efectivo,
-- CRYPTO=Cripto, OTHER=other active method.
DO $$ BEGIN CREATE TYPE payment_method AS ENUM
  ('TRANSFER', 'MOBILE', 'ZELLE', 'CASH', 'CRYPTO', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE setting_type AS ENUM
  ('INT', 'DECIMAL', 'BOOL', 'STRING', 'ENUM', 'JSON');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. Label helper (D2): sanitised ltree label derived from public_code.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_ltree_label(p_code TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT 'u_' || regexp_replace(lower(p_code), '[^a-z0-9_]', '_', 'g')
$$;
COMMENT ON FUNCTION fn_ltree_label(TEXT) IS
  'Derives a valid ltree label from users.public_code (D2).';

-- ---------------------------------------------------------------------------
-- 3. users (§5.1) — sponsor_id is canonical truth; path/depth are
-- trigger-maintained (never written by app code; see guard trigger §8).
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code             TEXT        NOT NULL,
  sponsor_id              UUID        NULL REFERENCES users (id) ON DELETE RESTRICT,
  path                    LTREE       NOT NULL,
  depth                   INTEGER     NOT NULL DEFAULT 0 CHECK (depth >= 0),
  role                    user_role   NOT NULL DEFAULT 'MEMBER',
  email                   CITEXT      NOT NULL,
  email_verified_at       TIMESTAMPTZ NULL,
  password_hash           TEXT        NOT NULL,
  full_name               TEXT        NOT NULL,
  national_id             TEXT        NULL,
  phone                   TEXT        NULL,
  birth_date              DATE        NULL,
  country                 TEXT        NULL,
  state                   TEXT        NULL,
  city                    TEXT        NULL,
  address                 TEXT        NULL,
  avatar_key              TEXT        NULL,
  status                  user_status NOT NULL DEFAULT 'ACTIVE',
  max_referrals_override  INTEGER     NULL CHECK (max_referrals_override IS NULL OR max_referrals_override > 0),
  timezone                TEXT        NULL,
  last_login_at           TIMESTAMPTZ NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at              TIMESTAMPTZ NULL,
  CONSTRAINT uq_users_email UNIQUE (email),
  CONSTRAINT uq_users_public_code UNIQUE (public_code)
);
COMMENT ON TABLE users IS '§5.1 referral tree nodes. path/depth maintained by triggers only.';
COMMENT ON COLUMN users.sponsor_id IS 'Canonical parent pointer. NULL only for the root.';
COMMENT ON COLUMN users.path IS 'Materialized path (ltree). Root = ''root''; child = parent || fn_ltree_label(public_code).';

-- §5 indexes: (sponsor_id), GiST (path), (email), (public_code), (status), (depth).
CREATE INDEX idx_users_sponsor ON users (sponsor_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_path ON users USING GIST (path);
CREATE INDEX idx_users_status ON users (status) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_depth ON users (depth) WHERE deleted_at IS NULL;
-- D5: plain UNIQUE (NULLs never conflict in Postgres).
CREATE UNIQUE INDEX uq_users_national_id ON users (national_id);
-- Exactly one root (NULL sponsor) even under concurrent seeds.
CREATE UNIQUE INDEX uq_users_single_root ON users ((1)) WHERE sponsor_id IS NULL;

-- ---------------------------------------------------------------------------
-- 4. user_closure (§5.2) — ancestor/descendant pairs, depth 0 = self.
-- ---------------------------------------------------------------------------
CREATE TABLE user_closure (
  ancestor_id   UUID    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  descendant_id UUID    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  depth         INTEGER NOT NULL CHECK (depth >= 0),
  CONSTRAINT pk_user_closure PRIMARY KEY (ancestor_id, descendant_id)
);
CREATE INDEX idx_closure_descendant ON user_closure (descendant_id, depth);
CREATE INDEX idx_closure_ancestor ON user_closure (ancestor_id, depth);

-- ---------------------------------------------------------------------------
-- 5. invitations (§5.3) — only SHA-256 of the token is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE invitations (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_id  UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  token_hash  TEXT        NOT NULL,
  kind        invite_kind NOT NULL DEFAULT 'MULTI',
  email_target CITEXT     NULL,
  max_uses    INTEGER     NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses        INTEGER     NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at  TIMESTAMPTZ NULL,
  revoked_at  TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_invitations_token_hash UNIQUE (token_hash)
);
CREATE INDEX idx_invitations_inviter ON invitations (inviter_id);

-- ---------------------------------------------------------------------------
-- 6. payment_cycles (§5.4) — EXCLUDE forbids overlapping windows.
-- ---------------------------------------------------------------------------
CREATE TABLE payment_cycles (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  period_key TEXT         NOT NULL,
  starts_at  TIMESTAMPTZ  NOT NULL,
  ends_at    TIMESTAMPTZ  NOT NULL CHECK (ends_at > starts_at),
  due_at     TIMESTAMPTZ  NOT NULL CHECK (due_at >= ends_at),
  status     cycle_status NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_cycles_period_key UNIQUE (period_key),
  CONSTRAINT no_overlap_cycles EXCLUDE USING GIST (tstzrange(starts_at, ends_at) WITH &&)
);
CREATE INDEX idx_cycles_status ON payment_cycles (status);

-- ---------------------------------------------------------------------------
-- 7. payment_methods (§5.6) — admin-configurable catalog.
-- ---------------------------------------------------------------------------
CREATE TABLE payment_methods (
  id                 UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  code               TEXT    NOT NULL,
  label              TEXT    NOT NULL,
  instructions       TEXT    NULL,
  requires_reference BOOLEAN NOT NULL DEFAULT TRUE,
  requires_proof     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT uq_payment_methods_code UNIQUE (code)
);

-- ---------------------------------------------------------------------------
-- 8. payment_reports (§5.5) — amounts NUMERIC(14,2), never float (R8).
-- ---------------------------------------------------------------------------
CREATE TABLE payment_reports (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  cycle_id        UUID          NOT NULL REFERENCES payment_cycles (id) ON DELETE RESTRICT,
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency        TEXT          NOT NULL,
  method          payment_method NOT NULL,
  method_id       UUID          NULL REFERENCES payment_methods (id) ON DELETE RESTRICT,
  reference       TEXT          NULL,
  paid_at         TIMESTAMPTZ   NOT NULL,
  reported_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  note            TEXT          NULL,
  proof_key       TEXT          NULL,
  status          report_status NOT NULL DEFAULT 'PENDING',
  reviewed_by     UUID          NULL REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ   NULL,
  review_note     TEXT          NULL,
  snapshot_depth  INTEGER       NOT NULL CHECK (snapshot_depth >= 0),
  snapshot_path   LTREE         NOT NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
-- §5 indexes: (cycle_id, user_id), (user_id, paid_at DESC), (status),
-- (reported_at DESC), GiST (snapshot_path).
CREATE INDEX idx_reports_cycle_user ON payment_reports (cycle_id, user_id);
CREATE INDEX idx_reports_user_paid ON payment_reports (user_id, paid_at DESC);
CREATE INDEX idx_reports_status ON payment_reports (status);
CREATE INDEX idx_reports_reported ON payment_reports (reported_at DESC);
CREATE INDEX idx_reports_snapshot_path ON payment_reports USING GIST (snapshot_path);
CREATE INDEX idx_reports_method ON payment_reports (method_id);
-- D4: partial unique enforcing R7 while the default max_reports_per_cycle = 1.
-- Rejected reports do not occupy the slot (author may correct and file again).
CREATE UNIQUE INDEX uq_report_user_cycle ON payment_reports (user_id, cycle_id)
  WHERE status <> 'REJECTED';

-- ---------------------------------------------------------------------------
-- 9. settings (§5.7) — business parameters; code NEVER hardcodes them.
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key         TEXT         PRIMARY KEY,
  value       JSONB        NOT NULL,
  type        setting_type NOT NULL,
  group_name  TEXT         NOT NULL,
  label       TEXT         NOT NULL,
  description TEXT         NULL,
  min_value   NUMERIC      NULL,
  max_value   NUMERIC      NULL,
  options     JSONB        NULL,
  is_public   BOOLEAN      NOT NULL DEFAULT FALSE,
  editable_by user_role    NOT NULL DEFAULT 'ROOT',
  updated_by  UUID         NULL REFERENCES users (id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
COMMENT ON TABLE settings IS '§5.7/§6 business parameters. Seeded in PR4; lib/settings.ts throws on missing key.';

-- ---------------------------------------------------------------------------
-- 10. custom_fields + custom_field_values (§5.8) — admin-defined schema.
-- ---------------------------------------------------------------------------
CREATE TABLE custom_fields (
  id                   UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  entity               TEXT    NOT NULL CHECK (entity IN ('USER', 'PAYMENT_REPORT')),
  code                 TEXT    NOT NULL,
  label                TEXT    NOT NULL,
  type                 TEXT    NOT NULL CHECK (type IN
    ('TEXT', 'TEXTAREA', 'NUMBER', 'DECIMAL', 'DATE', 'DATETIME', 'BOOL',
     'SELECT', 'MULTISELECT', 'FILE', 'EMAIL', 'PHONE', 'URL')),
  options              JSONB   NULL,
  is_required          BOOLEAN NOT NULL DEFAULT FALSE,
  is_unique            BOOLEAN NOT NULL DEFAULT FALSE,
  show_in_registration BOOLEAN NOT NULL DEFAULT FALSE,
  show_in_profile      BOOLEAN NOT NULL DEFAULT FALSE,
  show_in_dashboard    BOOLEAN NOT NULL DEFAULT FALSE,
  visible_to           user_role NULL,
  regex                TEXT    NULL,
  min_numeric          NUMERIC NULL,
  max_numeric          NUMERIC NULL,
  default_value        JSONB   NULL,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_custom_fields_entity_code UNIQUE (entity, code)
);

CREATE TABLE custom_field_values (
  id         UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id   UUID      NOT NULL REFERENCES custom_fields (id) ON DELETE CASCADE,
  entity_id  UUID      NOT NULL,
  value      JSONB     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_field_values_field_entity UNIQUE (field_id, entity_id)
);
CREATE INDEX idx_field_values_value ON custom_field_values USING GIN (value);

-- ---------------------------------------------------------------------------
-- 11. Support tables (§5.9)
-- ---------------------------------------------------------------------------
-- audit_log: R10 — every relevant write leaves a trace (no passwords/tokens).
CREATE TABLE audit_log (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   UUID        NULL REFERENCES users (id) ON DELETE SET NULL,
  action     TEXT        NOT NULL,
  entity     TEXT        NOT NULL,
  entity_id  TEXT        NOT NULL,
  "before"   JSONB       NULL,
  "after"    JSONB       NULL,
  ip         TEXT        NULL,
  user_agent TEXT        NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_log (entity, entity_id);
CREATE INDEX idx_audit_actor ON audit_log (actor_id);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);

CREATE TABLE notifications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type       TEXT        NOT NULL,
  title      TEXT        NOT NULL,
  body       TEXT        NULL,
  data       JSONB       NULL DEFAULT '{}',
  read_at    TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

-- Auth.js-standard tables (Credentials + email verification + reset).
CREATE TABLE sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token TEXT        NOT NULL,
  user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires       TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_sessions_token UNIQUE (session_token)
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires);

CREATE TABLE verification_tokens (
  identifier TEXT        NOT NULL,
  token      TEXT        NOT NULL,
  expires    TIMESTAMPTZ NOT NULL,
  CONSTRAINT pk_verification_tokens PRIMARY KEY (identifier, token)
);

CREATE TABLE password_resets (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_password_resets_token UNIQUE (token_hash)
);
CREATE INDEX idx_password_resets_user ON password_resets (user_id);

CREATE TABLE files (
  id         UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  key        TEXT   NOT NULL,
  owner_id   UUID   NULL REFERENCES users (id) ON DELETE SET NULL,
  mime       TEXT   NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  checksum   TEXT   NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_files_key UNIQUE (key)
);
CREATE INDEX idx_files_owner ON files (owner_id);

-- cycle_obligations (§9): materialised "who owes this week", built by jobs.
CREATE TABLE cycle_obligations (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id            UUID          NOT NULL REFERENCES payment_cycles (id) ON DELETE CASCADE,
  user_id             UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status              TEXT          NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'FULFILLED', 'MISSED', 'EXEMPT')),
  expected_amount     NUMERIC(14,2) NOT NULL CHECK (expected_amount >= 0),
  fulfilled_report_id UUID          NULL REFERENCES payment_reports (id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT uq_obligations_cycle_user UNIQUE (cycle_id, user_id)
);
CREATE INDEX idx_obligations_user ON cycle_obligations (user_id);
CREATE INDEX idx_obligations_cycle_status ON cycle_obligations (cycle_id, status);

CREATE TABLE rate_limits (
  key          TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER     NOT NULL DEFAULT 1 CHECK (count >= 0),
  CONSTRAINT pk_rate_limits PRIMARY KEY (key, window_start)
);

-- ---------------------------------------------------------------------------
-- 12. fn_effective_max_referrals (R2): per-user override else global setting.
-- Returns NULL when unconfigured (seed in PR4 guarantees the setting row;
-- lib/settings.ts throws on missing key at the app layer instead).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_effective_max_referrals(p_user_id UUID)
RETURNS INTEGER LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT u.max_referrals_override FROM users u WHERE u.id = p_user_id),
    (SELECT (s.value #>> '{}')::INTEGER FROM settings s
      WHERE s.key = 'referral.max_direct_referrals')
  )
$$;
COMMENT ON FUNCTION fn_effective_max_referrals(UUID) IS
  'R2 effective quota: users.max_referrals_override else settings referral.max_direct_referrals.';

-- ---------------------------------------------------------------------------
-- 13. Tree write path (D3): BEFORE assigns id/path/depth, AFTER writes
-- closure. Direct path/depth/sponsor_id rewrites are rejected by the guard;
-- fn_user_move() is the only legal way to rewire the tree (§10.5).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_user_tree_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_parent_path  LTREE;
  v_parent_depth INTEGER;
  v_root_count   INTEGER;
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := gen_random_uuid();
  END IF;
  IF NEW.sponsor_id IS NULL THEN
    -- Only the seeded root may have NULL sponsor; the partial unique index
    -- uq_users_single_root is the race-proof backstop for this check.
    SELECT count(*) INTO v_root_count FROM users WHERE sponsor_id IS NULL;
    IF v_root_count > 0 THEN
      RAISE EXCEPTION 'ROOT_ALREADY_EXISTS: only one root user is allowed'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.path  := 'root'::LTREE;
    NEW.depth := 0;
  ELSE
    -- Lock the parent so concurrent inserts under the same sponsor serialize
    -- here (quota itself is enforced by the F2 SERIALIZABLE transaction).
    SELECT path, depth INTO v_parent_path, v_parent_depth
      FROM users WHERE id = NEW.sponsor_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPONSOR_NOT_FOUND: %', NEW.sponsor_id
        USING ERRCODE = 'P0001';
    END IF;
    NEW.path  := v_parent_path || fn_ltree_label(NEW.public_code)::LTREE;
    NEW.depth := v_parent_depth + 1;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION fn_user_closure_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- All ancestors of the sponsor (self-row included, depth+1) plus self.
  -- For the root (sponsor NULL) the SELECT yields nothing: only the self row.
  INSERT INTO user_closure (ancestor_id, descendant_id, depth)
    SELECT ancestor_id, NEW.id, depth + 1 FROM user_closure
      WHERE descendant_id = NEW.sponsor_id
    UNION ALL
    SELECT NEW.id, NEW.id, 0;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_users_tree_before
  BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION fn_user_tree_insert();

CREATE TRIGGER trg_users_closure_after
  AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION fn_user_closure_insert();

-- Guard: any UPDATE touching tree columns outside fn_user_move() fails.
CREATE OR REPLACE FUNCTION fn_user_tree_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.tree_maintenance', TRUE) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.path IS DISTINCT FROM OLD.path
     OR NEW.depth IS DISTINCT FROM OLD.depth
     OR NEW.sponsor_id IS DISTINCT FROM OLD.sponsor_id THEN
    RAISE EXCEPTION 'TREE_WRITE_REJECTED: rewrite the tree only via fn_user_move()'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_users_tree_guard
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION fn_user_tree_guard();

-- ---------------------------------------------------------------------------
-- 14. fn_user_move (§4.1/§10.5): single-transaction subtree rewrite with
-- anti-cycle, R4 depth-limit and new-parent quota checks. Historical
-- payment_reports.snapshot_path rows are intentionally NOT touched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_user_move(p_user_id UUID, p_new_sponsor_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_user_public    TEXT;
  v_user_old_path  LTREE;
  v_user_old_depth INTEGER;
  v_parent_path    LTREE;
  v_parent_depth   INTEGER;
  v_parent_gone    TIMESTAMPTZ;
  v_new_user_path  LTREE;
  v_depth_delta    INTEGER;
  v_limit          INTEGER;
  v_subtree_extra  INTEGER;
  v_max_allowed    INTEGER;
  v_children       INTEGER;
  v_pending        INTEGER;
  v_count_pending  BOOLEAN;
BEGIN
  IF p_user_id = p_new_sponsor_id THEN
    RAISE EXCEPTION 'SELF_MOVE: a user cannot sponsor itself' USING ERRCODE = 'P0001';
  END IF;

  SELECT public_code, path, depth INTO v_user_public, v_user_old_path, v_user_old_depth
    FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: %', p_user_id USING ERRCODE = 'P0001';
  END IF;
  IF v_user_old_path = 'root'::LTREE THEN
    RAISE EXCEPTION 'ROOT_MOVE_FORBIDDEN: the root user cannot be moved' USING ERRCODE = 'P0001';
  END IF;
  IF p_new_sponsor_id IS NULL THEN
    RAISE EXCEPTION 'NULL_SPONSOR_FORBIDDEN: only the root has NULL sponsor' USING ERRCODE = 'P0001';
  END IF;

  SELECT path, depth, deleted_at INTO v_parent_path, v_parent_depth, v_parent_gone
    FROM users WHERE id = p_new_sponsor_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPONSOR_NOT_FOUND: %', p_new_sponsor_id USING ERRCODE = 'P0001';
  END IF;
  IF v_parent_gone IS NOT NULL THEN
    RAISE EXCEPTION 'SPONSOR_INACTIVE: target sponsor is soft-deleted' USING ERRCODE = 'P0001';
  END IF;

  -- Anti-cycle: the target must not live inside the moved subtree (R5).
  IF EXISTS (SELECT 1 FROM user_closure
             WHERE ancestor_id = p_user_id AND descendant_id = p_new_sponsor_id) THEN
    RAISE EXCEPTION 'CYCLIC_MOVE: target sponsor is inside the moved subtree'
      USING ERRCODE = 'P0001';
  END IF;

  -- R4: resulting deepest level must respect referral.max_depth (0 = unlimited).
  v_limit := 0;
  BEGIN
    SELECT (s.value #>> '{}')::INTEGER INTO v_limit FROM settings s
      WHERE s.key = 'referral.max_depth';
    IF v_limit IS NULL THEN v_limit := 0; END IF;
  EXCEPTION WHEN invalid_text_representation THEN v_limit := 0; END;
  IF v_limit > 0 THEN
    SELECT COALESCE(max(c.depth), 0) INTO v_subtree_extra FROM user_closure c
      WHERE c.ancestor_id = p_user_id;
    IF (v_parent_depth + 1 + v_subtree_extra) > v_limit THEN
      RAISE EXCEPTION 'DEPTH_LIMIT_EXCEEDED: move would exceed referral.max_depth'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- §10.5: the new parent must have a free slot (children + pending invites).
  v_max_allowed := fn_effective_max_referrals(p_new_sponsor_id);
  IF v_max_allowed IS NOT NULL THEN
    SELECT count(*) INTO v_children FROM users
      WHERE sponsor_id = p_new_sponsor_id AND deleted_at IS NULL;
    v_count_pending := TRUE;
    BEGIN
      SELECT (s.value #>> '{}')::BOOLEAN INTO v_count_pending FROM settings s
        WHERE s.key = 'referral.count_pending_in_limit';
      IF v_count_pending IS NULL THEN v_count_pending := TRUE; END IF;
    EXCEPTION WHEN invalid_text_representation THEN v_count_pending := TRUE; END;
    v_pending := 0;
    IF v_count_pending THEN
      SELECT count(*) INTO v_pending FROM invitations
        WHERE inviter_id = p_new_sponsor_id
          AND revoked_at IS NULL
          AND uses < max_uses
          AND (expires_at IS NULL OR expires_at > now());
    END IF;
    IF (v_children + v_pending) >= v_max_allowed THEN
      RAISE EXCEPTION 'REFERRAL_LIMIT_REJECTED: target sponsor has no free slot (409)'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Rewrite (guard trigger bypassed via transaction-local flag only).
  PERFORM set_config('app.tree_maintenance', 'on', TRUE);
  v_new_user_path := v_parent_path || fn_ltree_label(v_user_public)::LTREE;
  v_depth_delta  := (v_parent_depth + 1) - v_user_old_depth;

  UPDATE users SET sponsor_id = p_new_sponsor_id WHERE id = p_user_id;

  UPDATE users AS u SET
    path  = CASE WHEN u.id = p_user_id THEN v_new_user_path
                 ELSE v_new_user_path || subpath(u.path, nlevel(v_old_path)) END,
    depth = u.depth + v_depth_delta
    WHERE u.path <@ v_old_path;

  -- Closure: drop links whose ancestor is outside the moved subtree, then
  -- link every outside ancestor of the new sponsor to every subtree member.
  DELETE FROM user_closure c USING user_closure s
    WHERE s.ancestor_id = p_user_id
      AND s.descendant_id = c.descendant_id
      AND NOT EXISTS (SELECT 1 FROM user_closure s2
                      WHERE s2.ancestor_id = p_user_id
                        AND s2.descendant_id = c.ancestor_id);

  INSERT INTO user_closure (ancestor_id, descendant_id, depth)
    SELECT sup.ancestor_id, sub.descendant_id, sup.depth + 1 + sub.depth
      FROM (SELECT ancestor_id, depth FROM user_closure
             WHERE descendant_id = p_new_sponsor_id) sup
      CROSS JOIN (SELECT descendant_id, depth FROM user_closure
                   WHERE ancestor_id = p_user_id) sub
    ON CONFLICT DO NOTHING;

  PERFORM set_config('app.tree_maintenance', 'off', TRUE);
END $$;
COMMENT ON FUNCTION fn_user_move(UUID, UUID) IS
  '§4.1/§10.5 atomic subtree move with anti-cycle, depth-limit and quota checks.';

-- ---------------------------------------------------------------------------
-- 15. updated_at maintenance (tables that carry updated_at per §5).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_reports_updated_at BEFORE UPDATE ON payment_reports
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_settings_updated_at BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_custom_fields_updated_at BEFORE UPDATE ON custom_fields
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_field_values_updated_at BEFORE UPDATE ON custom_field_values
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
