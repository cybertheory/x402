-- Add content_type field to routes table
-- Values: 'website', 'file', 'api', or NULL (auto-detect)
ALTER TABLE routes 
ADD COLUMN IF NOT EXISTS content_type TEXT 
CHECK (content_type IS NULL OR content_type IN ('website', 'file', 'api'));

-- Add comment for documentation
COMMENT ON COLUMN routes.content_type IS 'Content type hint: website (return URL), file (stream), api (stream), or NULL (auto-detect)';

-- Update methods to support "ANY" - this is handled in application logic
-- The methods array can contain "ANY" which means all HTTP methods are allowed









