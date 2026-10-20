-- =============================================================================
-- red-referidos — 0006_identity_login
--
-- Identity model for the login/registration slice:
--   * email is no longer mandatory. Existing rows keep their address; new
--     members may register without one (directed invitations still require it).
--   * username becomes the stable handle members can log in with. It is stored
--     lower-case and constrained to a conservative, URL-safe vocabulary.
--   * national_id was already nullable and unique; the application now compares
--     a normalised form so "V-123" and "V 123" collide.
--
-- Additive only: no column is dropped or rewritten. There is deliberately NO
-- backfill. Legacy users keep logging in with their email, the root keeps its
-- national id, and nobody is assigned a username behind their back.
-- =============================================================================

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

ALTER TABLE users ADD COLUMN username CITEXT NULL;

CREATE UNIQUE INDEX uq_users_username ON users (username);

-- The application lowercases before writing. The CHECK is the database
-- backstop for direct SQL writes and mirrors USERNAME_PATTERN in lib/identity.ts.
ALTER TABLE users
  ADD CONSTRAINT ck_users_username_format
  CHECK (username IS NULL OR username ~ '^[a-z0-9._-]{3,30}$');
