-- Migration: Create tokens table for ERC-20 token management
-- Date: 2025-01-25
-- Purpose: Store ERC-20 token information linked to tenants

-- ============================================================================
-- 1. Create tokens table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  symbol text NOT NULL,
  decimals integer NOT NULL DEFAULT 18,
  initial_supply numeric NOT NULL,
  max_supply numeric,
  contract_address text NOT NULL,
  chain text NOT NULL,
  deployer_wallet_id uuid REFERENCES public.wallets(id) ON DELETE SET NULL,
  deployer_address text NOT NULL,
  is_paused boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ============================================================================
-- 2. Add indexes
-- ============================================================================

-- Index for tenant lookups
CREATE INDEX IF NOT EXISTS idx_tokens_tenant_id ON public.tokens(tenant_id);

-- Index for contract address lookups
CREATE INDEX IF NOT EXISTS idx_tokens_contract_address ON public.tokens(contract_address);

-- Index for chain lookups
CREATE INDEX IF NOT EXISTS idx_tokens_chain ON public.tokens(chain);

-- Unique constraint: each tenant can only have one token with the same contract address on the same chain
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_unique_contract_per_tenant 
ON public.tokens (tenant_id, contract_address, chain);

-- ============================================================================
-- 3. Add RLS policies
-- ============================================================================

-- Enable RLS
ALTER TABLE public.tokens ENABLE ROW LEVEL SECURITY;

-- Policy: Tenant members can view their tenant's tokens
CREATE POLICY "tenant members read tokens" ON public.tokens
  FOR SELECT
  TO authenticated
  USING (tenant_id IN (SELECT current_user_tenant_ids()));

-- Policy: Tenant members can insert tokens for their tenant
CREATE POLICY "tenant members insert tokens" ON public.tokens
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id IN (SELECT current_user_tenant_ids()));

-- Policy: Tenant members can update their tenant's tokens
CREATE POLICY "tenant members update tokens" ON public.tokens
  FOR UPDATE
  TO authenticated
  USING (tenant_id IN (SELECT current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT current_user_tenant_ids()));

-- Policy: Tenant members can delete their tenant's tokens
CREATE POLICY "tenant members delete tokens" ON public.tokens
  FOR DELETE
  TO authenticated
  USING (tenant_id IN (SELECT current_user_tenant_ids()));

-- ============================================================================
-- 4. Add updated_at trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION update_tokens_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_tokens_updated_at
  BEFORE UPDATE ON public.tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_tokens_updated_at();



