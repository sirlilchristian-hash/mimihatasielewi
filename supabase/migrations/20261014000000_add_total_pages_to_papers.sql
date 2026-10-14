-- Migration: Add total_pages column to public.Papers table
ALTER TABLE "Papers" ADD COLUMN IF NOT EXISTS total_pages INTEGER;

-- Comment for clarity
COMMENT ON COLUMN "Papers".total_pages IS 'Authoritative total page count of the stored PDF document extracted via pdf-lib.';
