# Environment Variables Setup Guide

This guide explains how to set up environment variables for different parts of the x402Instant project.

## Quick Start

1. **Supabase Edge Functions**: Set secrets via Supabase CLI or Dashboard
2. **Cloudflare Worker**: Set secrets via Wrangler CLI or Dashboard  
3. **Frontend Apps**: Create `.env.local` files in `web/` and `playground/`

## 1. Supabase Edge Functions

### Required Variables

```bash
CDP_API_KEY_ID=your-cdp-api-key-id
CDP_API_KEY_SECRET=your-cdp-api-key-secret
CDP_WALLET_SECRET=your-cdp-wallet-secret
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
```

### How to Set

**Option 1: Supabase CLI (Recommended)**
```bash
cd supabase
supabase secrets set CDP_API_KEY_ID=your-value
supabase secrets set CDP_API_KEY_SECRET=your-value
supabase secrets set CDP_WALLET_SECRET=your-value
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-value
```

**Option 2: Supabase Dashboard**
1. Go to your Supabase project
2. Navigate to: Edge Functions → Settings → Secrets
3. Add each secret key-value pair

### Where to Get Values

- **CDP Credentials**: https://portal.cdp.coinbase.com/
- **Supabase Service Role Key**: Dashboard → Settings → API → `service_role` key

### Cloudflare KV Sync (Optional)

If using `kv_sync_worker`:
```bash
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_KV_API_TOKEN=your-api-token
CLOUDFLARE_KV_NAMESPACE_ID=your-namespace-id
```

Get these from: Cloudflare Dashboard → Workers & Pages → KV

### Circle Faucet API Key (Required)

Required for `request_usdc_faucet`:
```bash
CIRCLE_FAUCET_API_KEY=your-circle-faucet-api-key
```

**Important**: 
- **Any Circle API Key works** - you don't need a specific "mint" key
- **Must be a testnet key** (not mainnet)
- Standard API Key type is fine

**How to get:**
1. Sign up at: https://console.circle.com/signup
2. Navigate to: API & Client Keys
3. Create a new API Key (choose "Standard" type)
4. Ensure it's for testnet use
5. Copy the key (it won't be shown again)

**Set in Supabase (NOT from .env files):**
```bash
# For production/cloud
supabase secrets set CIRCLE_FAUCET_API_KEY=your-key-here

# For local development
cd supabase
supabase secrets set CIRCLE_FAUCET_API_KEY=your-key-here
```

**Note**: Supabase Edge Functions read from Supabase secrets (set via CLI), NOT from local `.env` files. The `.env` files are only for frontend applications.

## 2. Cloudflare Worker

### Required Secrets

```bash
CDP_API_KEY_ID=your-cdp-api-key-id
CDP_API_KEY_SECRET=your-cdp-api-key-secret
```

### How to Set

**Option 1: Wrangler CLI (Recommended)**
```bash
wrangler secret put CDP_API_KEY_ID
# Enter value when prompted

wrangler secret put CDP_API_KEY_SECRET
# Enter value when prompted
```

**Option 2: Cloudflare Dashboard**
1. Go to Workers & Pages → Your Worker
2. Settings → Variables → Environment Variables
3. Add secrets (check "Encrypt" checkbox)

### Optional Variables

These are fallbacks if not specified in tenant KV config:
```bash
EVM_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
SOL_USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
ASSET_DECIMALS=6
```

## 3. Frontend Apps

### Next.js (web/)

Create `web/.env.local`:
```bash
NEXT_PUBLIC_SUPABASE_URL=https://sbdxcdwssrzvocnkcndq.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNiZHhjZHdzc3J6dm9jbmtjbmRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MTA4NjMsImV4cCI6MjA4MTM4Njg2M30.7vf5IfX1HhX9XrkLcSLeXbm_M03mPMxyZBhJfLSbjOs
```

Or copy from `web/env.example`:
```bash
cp web/env.example web/.env.local
```

### Vite/Playground (playground/)

Create `playground/.env.local`:
```bash
VITE_SUPABASE_URL=https://sbdxcdwssrzvocnkcndq.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNiZHhjZHdzc3J6dm9jbmtjbmRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU4MTA4NjMsImV4cCI6MjA4MTM4Njg2M30.7vf5IfX1HhX9XrkLcSLeXbm_M03mPMxyZBhJfLSbjOs
```

Or copy from `playground/env.example`:
```bash
cp playground/env.example playground/.env.local
```

### Where to Get Values

- **Supabase URL & Anon Key**: Dashboard → Settings → API
- **Production values**: Already configured in `env.example` files

### Note on Faucet API Key

The faucet API key is **NOT** stored in `.env` files. It's stored in browser localStorage and configured via the UI in the Faucet component. This is intentional for security and user-specific configuration.

## 4. Local Development

### Supabase Local Development

When running `supabase start`, the local instance uses:
- Default local credentials (auto-generated)
- Secrets set via `supabase secrets set` command
- Environment variables from your shell

### Testing Locally

1. Start Supabase: `supabase start`
2. Set secrets: `supabase secrets set KEY=value`
3. Run frontend: `cd web && npm run dev` or `cd playground && npm run dev`

## Security Best Practices

1. **Never commit `.env.local` files** - They're in `.gitignore`
2. **Use secrets management** - Don't hardcode credentials
3. **Rotate keys regularly** - Especially for production
4. **Use different keys** - Separate dev/staging/production environments
5. **Limit access** - Only give access to team members who need it

## Troubleshooting

### "CDP API credentials not configured"
- Check that secrets are set: `supabase secrets list`
- Verify secret names match exactly (case-sensitive)
- Restart Supabase: `supabase stop && supabase start`

### "Failed to load environment variables"
- Check `.env.local` file exists and is in the correct directory
- Verify variable names have correct prefix (`NEXT_PUBLIC_` or `VITE_`)
- Restart the dev server after changing `.env.local`

### "Faucet API error"
- The faucet API key is optional - some faucets don't require it
- Configure via UI in the Faucet component
- Check faucet service documentation for API key requirements

