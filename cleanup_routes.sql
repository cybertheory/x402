-- Clean up existing routes: Set content_type = 'website' for all routes
-- Run this via Supabase MCP or Supabase Dashboard SQL Editor

UPDATE routes
SET content_type = 'website'
WHERE content_type IS NULL;

-- Verify the update
SELECT 
  id,
  path_prefix,
  methods,
  mode,
  content_type,
  price_amount,
  created_at
FROM routes
ORDER BY created_at DESC;









