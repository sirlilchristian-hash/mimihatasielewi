-- Migration: Add purchased_pages and page_quantity columns to public.Orders table
ALTER TABLE "Orders" ADD COLUMN IF NOT EXISTS purchased_pages JSONB;
ALTER TABLE "Orders" ADD COLUMN IF NOT EXISTS page_quantity INTEGER;

-- Comments for clarity
COMMENT ON COLUMN "Orders".purchased_pages IS 'Array of 1-based original PDF page numbers purchased and selected via LIFO policy.';
COMMENT ON COLUMN "Orders".page_quantity IS 'Total number of pages purchased for this order.';
