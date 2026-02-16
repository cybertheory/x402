-- Update all existing routes to have content_type = 'website' if not already set
-- This cleans up existing data to use the new content_type field

UPDATE routes
SET content_type = 'website'
WHERE content_type IS NULL;

-- Optional: If you want to be more selective, you could update based on path patterns
-- For example, routes that look like websites:
-- UPDATE routes
-- SET content_type = 'website'
-- WHERE content_type IS NULL
--   AND (path_prefix LIKE '/%' OR path_prefix LIKE '%.html' OR path_prefix LIKE '%.htm');









