-- =============================================================================
-- red-referidos — 0004_tree_rebuild (function only, no schema change)
-- SDD slice F7.
--
-- `fn_tree_rebuild()` is the whole-tree repair for `tree:verify` (§9): it
-- rewrites `users.path`/`users.depth` and the `user_closure` table from the
-- canonical `sponsor_id` pointers, inside the caller's transaction.
--
-- Why a function and not app-side SQL:
--   * `trg_users_tree_guard` rejects any UPDATE of path/depth/sponsor_id
--     outside `fn_user_move()`. The rebuild is the deliberate, global version
--     of a move, so it flips the same transaction-local switch
--     (`app.tree_maintenance`, set_config(..., TRUE)) that fn_user_move()
--     already uses — one bypass mechanism, not two.
--   * The DELETE + INSERT on `user_closure` and the users UPDATE must be one
--     atomic unit; a plpgsql function gives the job a single call with a
--     single failure mode.
--
-- What it repairs, and what it cannot:
--   * It only walks DOWN from users with sponsor_id IS NULL (the single root
--     enforced by uq_users_single_root). A user whose sponsor chain is broken
--     (cycle or dangling reference introduced by manual SQL) is unreachable
--     from the walk and is left as-is: the canonical pointer is what it is,
--     and inventing a parent would be worse than reporting it. `tree:verify`
--     re-checks AFTER the rebuild and alerts about whatever remains.
--   * Deleted (soft-deleted) users are walked like any other row: they keep
--     their path/depth/closure rows after deletion, so consistency includes
--     them.
--
-- Returns the number of users whose path/depth changed (0 = nothing to fix).
-- Purely additive: no table, column or index changes, so existing databases
-- move forward with `prisma migrate deploy` and `db:check:drift` is unaffected.
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_tree_rebuild()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_fixed INTEGER;
BEGIN
  -- Transaction-local bypass of fn_user_tree_guard (D3); the same switch
  -- fn_user_move() flips for its subtree rewrite.
  PERFORM set_config('app.tree_maintenance', 'on', TRUE);

  -- 1. users.path / users.depth from the sponsor_id walk. The root keeps the
  --    literal 'root' label (fn_user_tree_insert assigns exactly that), and
  --    each child appends its own ltree label to its parent's expected path.
  WITH RECURSIVE walk AS (
    SELECT u.id,
           'root'::LTREE AS expected_path,
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

  -- 2. user_closure rebuilt from scratch: every ancestor->descendant pair
  --    implied by the walk, self rows included. DELETE + INSERT inside the
  --    caller's transaction, so no reader ever sees the empty intermediate
  --    state (and a failure rolls the whole rebuild back).
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

COMMENT ON FUNCTION fn_tree_rebuild() IS
  'tree:verify repair (§9): rewrites users.path/depth and user_closure from sponsor_id inside the caller transaction. Returns how many users changed.';
