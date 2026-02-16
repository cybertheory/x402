-- Migration: Create api_keys table for custom API key authentication
-- Date: 2025-12-26
-- Purpose: Store API keys for tenants to authenticate with x402Instant services

-- ============================================================================
-- 1. Create api_keys table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL, -- User-friendly name for the key
  key_hash text NOT NULL UNIQUE, -- Hashed version of the API key (SHA-256)
  key_prefix text NOT NULL, -- First 12 chars for display (e.g., "x402_abc123")
  is_active boolean NOT NULL DEFAULT true,
  last_used_at timestamp with time zone,
  expires_at timestamp with time zone, -- Optional: set expiration
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ============================================================================
-- 2. Add indexes
-- ============================================================================

-- Index for tenant lookups
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_id ON public.api_keys(tenant_id);

-- Index for key hash lookups (most common query)
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON public.api_keys(key_hash);

-- Index for active keys
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON public.api_keys(is_active) WHERE is_active = true;

-- ============================================================================
-- 3. Add RLS policies
-- ============================================================================

-- Enable RLS
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- Policy: Tenant members can view their tenant's API keys
CREATE POLICY "tenant members read api keys" ON public.api_keys
  FOR SELECT
  TO authenticated
  USING (tenant_id IN (SELECT current_user_tenant_ids()));

-- Policy: Tenant members can create API keys for their tenant
CREATE POLICY "tenant members create api keys" ON public.api_keys
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id IN (SELECT current_user_tenant_ids()));

-- Policy: Tenant members can update their tenant's API keys
CREATE POLICY "tenant members update api keys" ON public.api_keys
  FOR UPDATE
  TO authenticated
  USING (tenant_id IN (SELECT current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT current_user_tenant_ids()));

-- Policy: Tenant members can delete their tenant's API keys
CREATE POLICY "tenant members delete api keys" ON public.api_keys
  FOR DELETE
  TO authenticated
  USING (tenant_id IN (SELECT current_user_tenant_ids()));

-- ============================================================================
-- 4. Add updated_at trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION update_api_keys_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_api_keys_updated_at
  BEFORE UPDATE ON public.api_keys
  FOR EACH ROW
  EXECUTE FUNCTION update_api_keys_updated_at();

