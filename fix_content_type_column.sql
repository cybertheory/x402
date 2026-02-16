-- Fix content_type column in routes table
-- Run this via Supabase MCP or Supabase Dashboard SQL Editor

-- Add content_type column if it doesn't exist
ALTER TABLE routes 
ADD COLUMN IF NOT EXISTS content_type TEXT 
CHECK (content_type IS NULL OR content_type IN ('website', 'file', 'api'));

-- Add comment for documentation
COMMENT ON COLUMN routes.content_type IS 'Content type hint: website (return URL), file (stream), api (stream), or NULL (auto-detect)';

-- Verify the column exists
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'routes' AND column_name = 'content_type';









