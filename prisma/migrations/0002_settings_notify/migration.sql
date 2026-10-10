-- =============================================================================
-- red-referidos — 0002_settings_notify (additive, idempotent by design)
-- SDD slice PR4.
--
-- §6 requires: "caché en memoria de 60 s, invalidación por NOTIFY
-- settings_changed (LISTEN/NOTIFY de Postgres) para que un cambio surta efecto
-- en todas las instancias sin reiniciar". A trigger is the only way to honour
-- that for EVERY writer (admin panel, psql, a job), not just the app.
--
-- Why a new migration instead of editing 0001_init:
--   `prisma migrate deploy` stores a checksum per applied migration. Editing
--   0001_init would break every database where it already ran. 0002 is purely
--   additive: an object that did not exist before, so a database that already
--   applied 0001 can move forward without recreating anything.
--
-- NOT covered by `pnpm db:check:drift`: that checker compares schema.prisma
-- against 0001_init only, and triggers are DDL Prisma cannot express anyway
-- (same policy as the tree triggers of 0001).
--
-- Payload convention (read by lib/settings.ts): the setting key, so a listener
-- can invalidate just that entry. An empty payload means "invalidate all".
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_settings_notify()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_key TEXT;
BEGIN
  v_key := COALESCE(NEW.key, OLD.key);
  PERFORM pg_notify('settings_changed', v_key);
  RETURN COALESCE(NEW, OLD);
END $$;

COMMENT ON FUNCTION fn_settings_notify() IS
  'Raises settings_changed on every settings write so lib/settings.ts drops its 60s cache entry.';

DROP TRIGGER IF EXISTS trg_settings_notify ON settings;
CREATE TRIGGER trg_settings_notify
  AFTER INSERT OR UPDATE OR DELETE ON settings
  FOR EACH ROW EXECUTE FUNCTION fn_settings_notify();