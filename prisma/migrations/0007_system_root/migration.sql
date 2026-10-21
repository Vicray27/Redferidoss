-- =============================================================================
-- 0007_system_root — the developer ROOT is not a member of the referral tree.
--
-- Before this migration the schema allowed exactly one NULL-sponsor user and
-- treated it as both the system owner and the member-tree root. That made the
-- first pastor look like the developer's referral and counted the developer in
-- `networkSize` and every member directory. The two concepts are now separate:
--
--   * role ROOT  -> system account, path 'system', depth 0, outside the network
--   * role <>"ROOT" with sponsor_id NULL -> the single member-tree root,
--     path 'root', depth 0
--
-- The partial unique index still guarantees exactly one MEMBER root. A system
-- ROOT is allowed to coexist with it, and no member can be inserted or moved
-- underneath the system root.
-- =============================================================================

DROP INDEX IF EXISTS uq_users_single_root;

CREATE UNIQUE INDEX uq_users_single_member_root
  ON users ((1))
  WHERE sponsor_id IS NULL AND role <> 'ROOT';

-- ---------------------------------------------------------------------------
-- Tree insert: assign 'system' to a ROOT account and 'root' to the one member
-- root. Children of a ROOT account are rejected: the developer has no downline.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_user_tree_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_parent_path        LTREE;
  v_parent_depth       INTEGER;
  v_parent_role        user_role;
  v_member_root_count  INTEGER;
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := gen_random_uuid();
  END IF;
  IF NEW.sponsor_id IS NULL THEN
    IF NEW.role = 'ROOT' THEN
      -- System owner: a separate ltree namespace, outside the member tree.
      NEW.path  := 'system'::LTREE;
      NEW.depth := 0;
    ELSE
      -- The member tree has exactly one root. uq_users_single_member_root is
      -- the race-proof backstop for this check.
      SELECT count(*) INTO v_member_root_count
        FROM users WHERE sponsor_id IS NULL AND role <> 'ROOT';
      IF v_member_root_count > 0 THEN
        RAISE EXCEPTION 'ROOT_ALREADY_EXISTS: only one member root is allowed'
          USING ERRCODE = 'P0001';
      END IF;
      NEW.path  := 'root'::LTREE;
      NEW.depth := 0;
    END IF;
  ELSE
    -- Lock the parent so concurrent inserts under the same sponsor serialize
    -- here (quota itself is enforced by the F2 SERIALIZABLE transaction).
    SELECT path, depth, role INTO v_parent_path, v_parent_depth, v_parent_role
      FROM users WHERE id = NEW.sponsor_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPONSOR_NOT_FOUND: %', NEW.sponsor_id
        USING ERRCODE = 'P0001';
    END IF;
    IF v_parent_role = 'ROOT' THEN
      RAISE EXCEPTION 'SYSTEM_PARENT_FORBIDDEN: the system ROOT cannot sponsor members'
        USING ERRCODE = 'P0001';
    END IF;
    NEW.path  := v_parent_path || fn_ltree_label(NEW.public_code)::LTREE;
    NEW.depth := v_parent_depth + 1;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Tree move: both root paths are anchored, and a system ROOT can never become
-- a parent. Everything else keeps the 0001 behaviour.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_user_move(p_user_id UUID, p_new_sponsor_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_user_public    TEXT;
  v_user_old_path  LTREE;
  v_user_old_depth INTEGER;
  v_user_role      user_role;
  v_parent_path    LTREE;
  v_parent_depth   INTEGER;
  v_parent_role    user_role;
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

  SELECT public_code, path, depth, role
    INTO v_user_public, v_user_old_path, v_user_old_depth, v_user_role
    FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: %', p_user_id USING ERRCODE = 'P0001';
  END IF;
  IF v_user_role = 'ROOT' OR v_user_old_path IN ('root'::LTREE, 'system'::LTREE) THEN
    RAISE EXCEPTION 'ROOT_MOVE_FORBIDDEN: a root or system user cannot be moved'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_new_sponsor_id IS NULL THEN
    RAISE EXCEPTION 'NULL_SPONSOR_FORBIDDEN: only roots have NULL sponsor' USING ERRCODE = 'P0001';
  END IF;

  SELECT path, depth, role, deleted_at
    INTO v_parent_path, v_parent_depth, v_parent_role, v_parent_gone
    FROM users WHERE id = p_new_sponsor_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SPONSOR_NOT_FOUND: %', p_new_sponsor_id
      USING ERRCODE = 'P0001';
  END IF;
  IF v_parent_role = 'ROOT' THEN
    RAISE EXCEPTION 'SYSTEM_PARENT_FORBIDDEN: the system ROOT cannot sponsor members'
      USING ERRCODE = 'P0001';
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

-- ---------------------------------------------------------------------------
-- Whole-tree rebuild: the expected root label depends on the account role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_tree_rebuild()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_fixed INTEGER;
BEGIN
  PERFORM set_config('app.tree_maintenance', 'on', TRUE);

  WITH RECURSIVE walk AS (
    SELECT u.id,
           CASE WHEN u.role = 'ROOT' THEN 'system'::LTREE ELSE 'root'::LTREE END AS expected_path,
           0 AS expected_depth
    FROM users u
    WHERE u.sponsor_id IS NULL
    UNION ALL
    SELECT c.id,
           w.expected_path || fn_ltree_label(c.public_code)::LTREE,
           w.expected_depth + 1
    FROM users c
    JOIN walk w ON c.sponsor_id = w.id
  )
  UPDATE users u
  SET path  = w.expected_path,
      depth = w.expected_depth
  FROM walk w
  WHERE w.id = u.id
    AND (u.path IS DISTINCT FROM w.expected_path
      OR u.depth IS DISTINCT FROM w.expected_depth);

  GET DIAGNOSTICS v_fixed = ROW_COUNT;

  DELETE FROM user_closure;

  INSERT INTO user_closure (ancestor_id, descendant_id, depth)
  WITH RECURSIVE walk AS (
    SELECT u.id, ARRAY[u.id] AS chain
    FROM users u
    WHERE u.sponsor_id IS NULL
    UNION ALL
    SELECT c.id, w.chain || c.id
    FROM users c
    JOIN walk w ON c.sponsor_id = w.id
  )
  SELECT w.chain[g], w.id, array_length(w.chain, 1) - g
  FROM walk w
  CROSS JOIN LATERAL generate_series(1, array_length(w.chain, 1)) AS g;

  PERFORM set_config('app.tree_maintenance', 'off', TRUE);
  RETURN v_fixed;
END $$;

-- ---------------------------------------------------------------------------
-- Promote the first member root. In the current production dataset that is
-- the pastor (the only active ADMIN child of the developer ROOT). Fresh
-- databases have no candidate and are a no-op.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_system_root UUID;
  v_member_root UUID;
BEGIN
  SELECT id INTO v_system_root
    FROM users
    WHERE sponsor_id IS NULL AND role = 'ROOT'
    ORDER BY created_at, id
    LIMIT 1;

  IF v_system_root IS NOT NULL THEN
    SELECT u.id INTO v_member_root
      FROM users u
      WHERE u.sponsor_id = v_system_root
        AND u.role <> 'ROOT'
        AND u.deleted_at IS NULL
      ORDER BY (u.role = 'ADMIN') DESC, u.created_at, u.id
      LIMIT 1;

    IF v_member_root IS NOT NULL THEN
      PERFORM set_config('app.tree_maintenance', 'on', TRUE);
      UPDATE users SET sponsor_id = NULL WHERE id = v_member_root;
      PERFORM set_config('app.tree_maintenance', 'off', TRUE);
    END IF;
  END IF;
END $$;

SELECT fn_tree_rebuild();

COMMENT ON INDEX uq_users_single_member_root IS
  'Exactly one member-tree root (sponsor_id NULL, role <> ROOT); system ROOT accounts are separate.';
COMMENT ON FUNCTION fn_tree_rebuild() IS
  'tree:verify repair (§9): rewrites users.path/depth and user_closure from sponsor_id inside the caller transaction. System ROOT accounts use path system; the member root uses root.';
