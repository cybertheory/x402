-- Migration: Fix RLS policies to use authenticated role and fix function search_path
-- Date: 2025-12-15
-- Purpose: Ensure only authenticated users can access tenant data and fix SQL injection vulnerabilities

-- ============================================================================
-- 1. Fix function search_path issues (SQL injection prevention)
-- ============================================================================

-- Fix notify_kv_sync function
ALTER FUNCTION public.notify_kv_sync(p_tenant_id uuid) 
SET search_path = 'public';

-- Fix enqueue_kv_sync_for_tenant function
ALTER FUNCTION public.enqueue_kv_sync_for_tenant() 
SET search_path = 'public';

-- ============================================================================
-- 2. Fix RLS policies to use authenticated role instead of public
-- ============================================================================

-- Fix events table: Change from public to authenticated role
DROP POLICY IF EXISTS "tenant members read events" ON public.events;

CREATE POLICY "tenant members read events" ON public.events
  FOR SELECT
  TO authenticated
  USING (tenant_id IN (SELECT current_user_tenant_ids()));

-- Fix tenant_members table: Change from public to authenticated role
DROP POLICY IF EXISTS "tenant members manage tenant_members" ON public.tenant_members;

CREATE POLICY "tenant members manage tenant_members" ON public.tenant_members
  FOR ALL
  TO authenticated
  USING (tenant_id IN (SELECT current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT current_user_tenant_ids()));

-- ============================================================================
-- 3. Verify all policies are correctly configured
-- ============================================================================

-- All tables should now have:
-- - Service role policies for backend operations (service_role)
-- - Tenant member policies for authenticated users (authenticated)
-- - No public role policies (except service_role which is fine)

-- Note: The following tables already have authenticated role policies:
-- - tenants: ✅ "tenant members manage tenants" (authenticated)
-- - domains: ✅ "tenant members manage domains" (authenticated)
-- - wallets: ✅ "tenant members manage wallets" (authenticated)
-- - origins: ✅ "tenant members manage origins" (authenticated)
-- - routes: ✅ "tenant members manage routes" (authenticated)













