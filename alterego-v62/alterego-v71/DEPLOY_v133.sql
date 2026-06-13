-- ============================================================================
-- DEPLOY_v133.sql  —  run ONCE in the Supabase SQL editor before/with the
-- v133 deploy. Safe to re-run (uses IF NOT EXISTS / guarded constraint adds).
-- ============================================================================

-- ── 1. animate_jobs ─────────────────────────────────────────────────────────
-- Binds each Kling animation request to the user who paid for it and tracks
-- whether its 8-credit refund has been issued, so a failed/timed-out job can be
-- refunded at most once (replay protection in /api/animate-poll).
CREATE TABLE IF NOT EXISTS public.animate_jobs (
  request_id  text PRIMARY KEY,
  user_id     uuid NOT NULL,
  refunded    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS animate_jobs_user_idx ON public.animate_jobs (user_id);

-- This table is only ever touched by server-side service-key code, never the
-- browser. Enable RLS with no policies so anon/auth roles get zero access.
ALTER TABLE public.animate_jobs ENABLE ROW LEVEL SECURITY;

-- ── 2. payments uniqueness ──────────────────────────────────────────────────
-- The Stripe credit grant is made idempotent by inserting the payment row first
-- and letting a UNIQUE violation on stripe_session_id signal "already granted".
-- This guarantees the verify_payment path and the webhook can race safely and
-- still grant exactly once. Add the constraint if it isn't already present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_stripe_session_id_key'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_stripe_session_id_key UNIQUE (stripe_session_id);
  END IF;
END $$;
