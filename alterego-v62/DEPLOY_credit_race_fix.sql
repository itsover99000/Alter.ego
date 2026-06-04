-- ============================================================================
-- ALTER.EGO — Credit-race fix: atomic credit deduction
-- ============================================================================
-- RUN THIS IN THE SUPABASE SQL EDITOR **BEFORE** DEPLOYING THE NEW CODE.
-- The new api/image.js calls this function; if the code deploys before the
-- function exists, every generation will fail.
--
-- Safe to re-run: CREATE OR REPLACE will not error or duplicate.
-- ============================================================================

CREATE OR REPLACE FUNCTION deduct_credits_if_available(
  p_user_id uuid,
  p_cost integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_credits integer;
BEGIN
  -- Single atomic statement: the UPDATE only applies to the row when the
  -- balance is sufficient. Two concurrent calls cannot both succeed because
  -- the row is locked for the duration of each UPDATE — the second waits,
  -- re-evaluates `credits >= p_cost` against the already-decremented value,
  -- and fails the guard if there aren't enough credits left.
  UPDATE profiles
     SET credits = credits - p_cost
   WHERE id = p_user_id
     AND credits >= p_cost
  RETURNING credits INTO v_new_credits;

  -- No row updated => insufficient credits (or lost the race). Return NULL so
  -- the caller can distinguish "declined" from a real new balance (including 0).
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN v_new_credits;
END;
$$;

-- ---------------------------------------------------------------------------
-- VERIFY the function exists before deploying code. Run this and confirm a row:
--   SELECT proname FROM pg_proc WHERE proname = 'deduct_credits_if_available';
--
-- OPTIONAL smoke test (replace the uuid with a real test profile id):
--   SELECT deduct_credits_if_available('00000000-0000-0000-0000-000000000000'::uuid, 1);
-- Returns the new balance on success, or NULL if that profile lacks 1 credit.
-- ---------------------------------------------------------------------------
