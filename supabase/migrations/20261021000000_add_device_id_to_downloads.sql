-- Migration: Add device_id and download_type columns to public."downloads"
-- Target Tables: public."downloads", public."Orders", public."device_requests"
-- Description: Decouples surrogate primary key (downloads.id) from persistent client device_id cookie,
-- enforces the 3-device limit atomically under concurrent requests, validates order/paper entitlement,
-- restricts RPC execution strictly to service_role, and preserves all 38 historical download rows.

-- ============================================================================
-- 1. DDL: Add device_id and download_type columns to public."downloads"
-- ============================================================================
ALTER TABLE public."downloads" ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE public."downloads" ADD COLUMN IF NOT EXISTS download_type TEXT;

COMMENT ON COLUMN public."downloads".device_id IS 'Persistent browser device UUID from device_id cookie, uniquely scoped per order.';
COMMENT ON COLUMN public."downloads".download_type IS 'Distinguishes browser device registrations (browser_device) from direct PDF file downloads (direct_pdf). Historical rows remain NULL.';

-- ============================================================================
-- 2. INDEXES: Fast lookup & unique constraint for same-device per-order
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_downloads_order_device 
ON public."downloads" (order_id, device_id);

-- Enforces that a given device cannot be registered more than once for the same order.
-- Partial unique index ensures historical rows with device_id IS NULL are completely unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_downloads_order_device 
ON public."downloads" (order_id, device_id) 
WHERE device_id IS NOT NULL;

-- ============================================================================
-- 2b. EXPLICIT RECONCILIATION: public."device_requests"
-- ============================================================================
-- Production schema verification: public."device_requests" already exists with 
-- (id, order_id, status, created_at, processed_at) and 0 rows.
-- We ensure table existence idempotently and safely enforce order_id NOT NULL if nullable.
CREATE TABLE IF NOT EXISTS public."device_requests" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES public."Orders"(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

DO $$
DECLARE
  v_null_count INT;
  v_fk_name TEXT;
  v_ref_schema TEXT;
  v_ref_table TEXT;
  v_ref_column TEXT;
  v_delete_rule TEXT;
  v_fk_count INT := 0;
BEGIN
  -- Check if order_id is nullable in existing table (confirmed 0 rows in production)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'device_requests' 
      AND column_name = 'order_id' 
      AND is_nullable = 'YES'
  ) THEN
    SELECT COUNT(*) INTO v_null_count 
    FROM public."device_requests" 
    WHERE order_id IS NULL;

    IF v_null_count > 0 THEN
      RAISE EXCEPTION 'Schema reconciliation halted: found % row(s) in public.device_requests with NULL order_id. Cannot safely apply NOT NULL constraint.', v_null_count;
    END IF;

    ALTER TABLE public."device_requests" ALTER COLUMN order_id SET NOT NULL;
  END IF;

  -- Validate foreign key constraint on public.device_requests(order_id) across all three properties:
  -- 1) Referencing column: order_id
  -- 2) Referenced table and column: public."Orders"(id)
  -- 3) Referential action: ON DELETE CASCADE
  FOR v_fk_name, v_ref_schema, v_ref_table, v_ref_column, v_delete_rule IN
    SELECT 
      tc.constraint_name,
      ccu.table_schema,
      ccu.table_name,
      ccu.column_name,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name 
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name 
     AND tc.table_schema = rc.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name 
     AND tc.table_schema = ccu.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = 'device_requests'
      AND kcu.column_name = 'order_id'
  LOOP
    v_fk_count := v_fk_count + 1;
    IF v_ref_schema <> 'public' 
       OR v_ref_table <> 'Orders' 
       OR v_ref_column <> 'id' 
       OR v_delete_rule <> 'CASCADE' THEN
      RAISE EXCEPTION 'Schema reconciliation halted: found incompatible foreign key constraint "%" on public.device_requests(order_id). References %.%(%) with ON DELETE %, expected public."Orders"(id) with ON DELETE CASCADE.',
        v_fk_name, v_ref_schema, v_ref_table, v_ref_column, v_delete_rule;
    END IF;
  END LOOP;

  -- If no foreign key exists on order_id, create the authoritative constraint
  IF v_fk_count = 0 THEN
    ALTER TABLE public."device_requests"
      ADD CONSTRAINT fk_device_requests_orders
      FOREIGN KEY (order_id) REFERENCES public."Orders"(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_device_requests_order_status
ON public."device_requests" (order_id, status);

COMMENT ON TABLE public."device_requests" IS 'Stores device limit exception requests submitted by customers and reviewed by administrators.';

-- ============================================================================
-- 3. HISTORICAL DATA RECONCILIATION POLICY:
-- ============================================================================
-- Bulk backfill is INTENTIONALLY OMITTED. All 38 existing rows (including the two 
-- rows with null paper_id) are strictly preserved without modification.
-- Automatic promotion of historical rows based solely on downloads.id = device_id 
-- is completely removed to prevent ambiguous or fabricated device registrations.

-- ============================================================================
-- 4. ATOMIC RPC: register_document_device
-- ============================================================================
CREATE OR REPLACE FUNCTION public.register_document_device(
  p_order_id UUID,
  p_paper_id UUID,
  p_device_id TEXT,
  p_base_limit INT DEFAULT 3
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_distinct_count INT;
  v_approved_extra INT;
  v_effective_limit INT;
  v_new_id UUID;
  v_order_status TEXT;
  v_order_paper_id UUID;
  v_violated_constraint TEXT;
BEGIN
  -- 1. Input parameter validation
  IF p_order_id IS NULL OR p_device_id IS NULL OR TRIM(p_device_id) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_parameters');
  END IF;

  -- 1b. Defensive UUID format validation for p_device_id (8-4-4-4-12 hex characters)
  IF p_device_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_device_id');
  END IF;

  -- 2. Row-level lock on public."Orders" to serialize concurrent registrations for this order
  SELECT paper_id, status INTO v_order_paper_id, v_order_status
  FROM public."Orders"
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
  END IF;

  -- Validates that order is confirmed/paid (works for both M-Pesa paid orders and FREE_ACCESS purchases)
  -- Null-safe comparison ensures NULL status can never be treated as paid
  IF v_order_status IS DISTINCT FROM 'paid' THEN
    RETURN jsonb_build_object('success', false, 'error', 'order_not_paid');
  END IF;

  -- 3. Authoritative paper entitlement check
  -- Null-safe comparison prevents non-null requested paper from bypassing validation when order paper_id is NULL,
  -- while preserving legitimate orders where both paper IDs are NULL.
  IF p_paper_id IS DISTINCT FROM v_order_paper_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'paper_mismatch');
  END IF;

  -- 4. Idempotent check: Is this device already registered for this order?
  IF EXISTS (
    SELECT 1 FROM public."downloads"
    WHERE order_id = p_order_id AND device_id = p_device_id
  ) THEN
    RETURN jsonb_build_object(
      'success', true,
      'status', 'already_registered',
      'device_id', p_device_id
    );
  END IF;

  -- 5. Compute effective limit (clamped base limit + approved device exception requests)
  BEGIN
    SELECT COALESCE(COUNT(DISTINCT id), 0) INTO v_approved_extra
    FROM public."device_requests"
    WHERE order_id = p_order_id AND status = 'approved';
  EXCEPTION
    WHEN undefined_table THEN
      v_approved_extra := 0;
  END;

  v_effective_limit := LEAST(
    LEAST(GREATEST(COALESCE(p_base_limit, 3), 0), 3)
      + v_approved_extra,
    5
  );

  -- 6. Count currently registered distinct browser devices for this order (excludes direct PDF / NULL device_id rows)
  SELECT COUNT(DISTINCT device_id) INTO v_distinct_count
  FROM public."downloads"
  WHERE order_id = p_order_id AND device_id IS NOT NULL;

  IF v_distinct_count >= v_effective_limit THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'device_limit_reached',
      'limit', v_effective_limit,
      'current_count', v_distinct_count
    );
  END IF;

  -- 7. Atomic insert using authoritative order paper_id and independent surrogate UUID primary key
  BEGIN
    INSERT INTO public."downloads" (order_id, paper_id, device_id, download_type, downloaded_at)
    VALUES (p_order_id, v_order_paper_id, p_device_id, 'browser_device', NOW())
    RETURNING id INTO v_new_id;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_violated_constraint = CONSTRAINT_NAME;
      -- Handle as already_registered ONLY when the violated constraint is uq_downloads_order_device
      -- and a matching (order_id, device_id) row exists
      IF v_violated_constraint = 'uq_downloads_order_device' THEN
        IF EXISTS (
          SELECT 1 FROM public."downloads"
          WHERE order_id = p_order_id AND device_id = p_device_id
        ) THEN
          RETURN jsonb_build_object(
            'success', true,
            'status', 'already_registered',
            'device_id', p_device_id
          );
        END IF;
      END IF;
      -- Re-raise unrelated unique violations (e.g., primary key collisions)
      RAISE;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'registered',
    'id', v_new_id,
    'device_id', p_device_id,
    'current_count', v_distinct_count + 1,
    'limit', v_effective_limit
  );
END;
$$;

-- ============================================================================
-- 4b. ATOMIC RPC: approve_device_request
-- ============================================================================
CREATE OR REPLACE FUNCTION public.approve_device_request(
  p_request_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_order_id UUID;
  v_request_status TEXT;
  v_approved_count INT;
BEGIN
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_parameters');
  END IF;

  -- 1. Fetch request details and check existence
  SELECT order_id, status INTO v_order_id, v_request_status
  FROM public."device_requests"
  WHERE id = p_request_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_not_found');
  END IF;

  -- Null-safe comparison prevents NULL status from passing
  IF v_request_status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_not_pending');
  END IF;

  -- 2. Lock the parent Order row with FOR UPDATE and verify existence
  PERFORM 1 FROM public."Orders"
  WHERE id = v_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
  END IF;

  -- Recheck request status under order lock
  SELECT status INTO v_request_status
  FROM public."device_requests"
  WHERE id = p_request_id;

  IF v_request_status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_not_pending');
  END IF;

  -- 3. Atomically count existing distinct approved requests under lock (max 2 extra approvals = 5 total devices)
  SELECT COUNT(DISTINCT id) INTO v_approved_count
  FROM public."device_requests"
  WHERE order_id = v_order_id AND status = 'approved';

  IF v_approved_count >= 2 THEN
    RETURN jsonb_build_object('success', false, 'error', 'maximum_approvals_reached');
  END IF;

  -- 4. Atomically approve the request
  UPDATE public."device_requests"
  SET status = 'approved',
      processed_at = NOW()
  WHERE id = p_request_id
    AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_not_pending');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'approved',
    'approved_count', v_approved_count + 1,
    'effective_limit', LEAST(3 + v_approved_count + 1, 5)
  );
END;
$$;

-- ============================================================================
-- 4c. ATOMIC RPC: reject_device_request
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reject_device_request(
  p_request_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_order_id UUID;
  v_request_status TEXT;
BEGIN
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_parameters');
  END IF;

  -- 1. Fetch request details and check existence
  SELECT order_id, status INTO v_order_id, v_request_status
  FROM public."device_requests"
  WHERE id = p_request_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_not_found');
  END IF;

  -- Null-safe comparison prevents NULL status from passing
  IF v_request_status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_not_pending');
  END IF;

  -- 2. Lock the parent Order row with FOR UPDATE and verify existence
  PERFORM 1 FROM public."Orders"
  WHERE id = v_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'order_not_found');
  END IF;

  -- Recheck request status under order lock
  SELECT status INTO v_request_status
  FROM public."device_requests"
  WHERE id = p_request_id;

  IF v_request_status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_not_pending');
  END IF;

  -- 3. Atomically reject the request
  UPDATE public."device_requests"
  SET status = 'rejected',
      processed_at = NOW()
  WHERE id = p_request_id
    AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'request_not_pending');
  END IF;

  RETURN jsonb_build_object('success', true, 'status', 'rejected');
END;
$$;

-- ============================================================================
-- 5. ACCESS CONTROL: Strictly restrict execution to service_role
-- ============================================================================
REVOKE ALL ON FUNCTION public.register_document_device(UUID, UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_device_request(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_device_request(UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.register_document_device(UUID, UUID, TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_device_request(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_device_request(UUID) TO service_role;

GRANT ALL ON TABLE public."device_requests" TO service_role;
GRANT ALL ON TABLE public."downloads" TO service_role;

-- Prevent untrusted roles from creating objects in the public schema that could shadow execution
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

