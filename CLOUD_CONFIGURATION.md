# Cloud Configuration Update

The frontend applications have been updated to use the Supabase cloud instance instead of localhost.

## Changes Made

### 1. Playground App
- ✅ Created `playground/src/lib/supabaseClient.ts` - Supabase client with environment variable validation
- ✅ Updated `playground/src/lib/walletUtils.ts` - Now uses Supabase client instead of direct fetch with localhost fallback
- ✅ Added `@supabase/supabase-js` dependency
- ✅ Created `playground/env.example` with production Supabase credentials

### 2. Web App
- ✅ Already configured correctly - uses `NEXT_PUBLIC_SUPABASE_URL` from environment
- ✅ Created `web/env.example` with production Supabase credentials

## Required Setup

### Playground
1. Copy the example file:
   ```bash
   cp playground/env.example playground/.env.local
   ```

2. The `.env.local` file should contain:
   ```bash
   VITE_SUPABASE_URL=https://sbdxcdwssrzvocnkcndq.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNiZHhjZHdzc3J6dm9jbmtjbmRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MTA4NjMsImV4cCI6MjA4MTM4Njg2M30.7vf5IfX1HhX9XrkLcSLeXbm_M03mPMxyZBhJfLSbjOs
   ```

3. Restart the dev server:
   ```bash
   cd playground && npm run dev
   ```

### Web App
1. Copy the example file:
   ```bash
   cp web/env.example web/.env.local
   ```

2. The `.env.local` file should contain:
   ```bash
   NEXT_PUBLIC_SUPABASE_URL=https://sbdxcdwssrzvocnkcndq.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNiZHhjZHdzc3J6dm9jbmtjbmRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MTA4NjMsImV4cCI6MjA4MTM4Njg2M30.7vf5IfX1HhX9XrkLcSLeXbm_M03mPMxyZBhJfLSbjOs
   ```

3. Restart the dev server:
   ```bash
   cd web && npm run dev
   ```

## Verification

Both apps will now:
- ✅ Connect to Supabase cloud: `https://sbdxcdwssrzvocnkcndq.supabase.co`
- ✅ Use the production Supabase Edge Functions
- ✅ Call the faucet function from cloud (not localhost)
- ✅ Throw clear errors if environment variables are missing

## Production Supabase Project

- **Project ID**: `sbdxcdwssrzvocnkcndq`
- **URL**: `https://sbdxcdwssrzvocnkcndq.supabase.co`
- **Status**: Active and healthy

## Important Notes

1. **No localhost fallbacks**: Both apps now require environment variables and will fail if they're not set
2. **Environment files**: `.env.local` files are gitignored - they must be created locally
3. **Example files**: `env.example` files are committed with production values for easy setup








