# Faucet Setup Guide

The USDC testnet faucet has been moved to a Supabase Edge Function for security. The API key is now stored server-side instead of in the browser.

## What Changed

1. **Created Supabase Edge Function**: `request_usdc_faucet`
   - Located at: `supabase/functions/request_usdc_faucet/`
   - Public endpoint (no authentication required)
   - Securely calls Circle's testnet faucet API

2. **Updated Frontend**:
   - Removed API key management from browser localStorage
   - Frontend now calls Supabase Edge Function
   - API key is stored securely in Supabase secrets

3. **Switched to Circle Faucet**:
   - Removed Crossmint references
   - Now uses Circle's testnet faucet API

## Deployment Status

✅ Function deployed to Supabase project: `sbdxcdwssrzvocnkcndq`
✅ Function is public (no auth required)
✅ Configuration added to `supabase/config.toml`

## Setting Up Circle Faucet API Key (Required)

Circle's testnet faucet requires an API key. Set it as a Supabase secret:

```bash
# Using Supabase CLI
supabase secrets set CIRCLE_FAUCET_API_KEY=your-api-key-here

# Or via Supabase Dashboard
# Go to: Project Settings → Edge Functions → Secrets
# Add: CIRCLE_FAUCET_API_KEY = your-api-key-here
```

**How to get Circle API Key:**
1. Sign up at: https://console.circle.com/signup
2. Navigate to: API & Client Keys
3. Create a new API Key
4. Copy the key (it won't be shown again)

**Note:** The function will return an error if the API key is not set.

## Testing the Function

### Local Testing

1. Start Supabase locally:
```bash
supabase start
```

2. Set the secret (if needed):
```bash
supabase secrets set CIRCLE_FAUCET_API_KEY=your-key
```

3. Test the function:
```bash
curl -X POST http://127.0.0.1:54321/functions/v1/request_usdc_faucet \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -d '{"address": "0xYourAddress", "chain": "base-sepolia"}'
```

### Production Testing

The function is available at:
```
https://sbdxcdwssrzvocnkcndq.supabase.co/functions/v1/request_usdc_faucet
```

## Frontend Usage

The frontend automatically uses the Supabase function. No changes needed in the UI - just click "Request USDC from Faucet" and it will call the secure server-side function.

### Playground
- Uses environment variable `VITE_SUPABASE_URL` (defaults to localhost for dev)
- Calls: `${supabaseUrl}/functions/v1/request_usdc_faucet`

### Web App
- Uses Supabase client from `@/lib/supabaseClient`
- Calls: `supabaseBrowser.functions.invoke('request_usdc_faucet', ...)`

## Function Configuration

The function is configured in `supabase/config.toml`:

```toml
[functions.request_usdc_faucet]
enabled = true
verify_jwt = false  # Public endpoint, no auth required
```

## Security Notes

1. ✅ API key is stored server-side in Supabase secrets
2. ✅ Function is public (no auth) but rate-limited by Supabase
3. ✅ Input validation (address format, chain validation)
4. ✅ Error handling and logging
5. ✅ CORS headers configured

## Troubleshooting

### "Function not found"
- Ensure function is deployed: `npx supabase functions deploy request_usdc_faucet`
- Check function is enabled in `supabase/config.toml`

### "Faucet API error"
- Check if Circle faucet API endpoint is correct
- Verify `CIRCLE_FAUCET_API_KEY` is set if required
- Check Supabase function logs in dashboard

### "CORS error"
- CORS headers are configured in the function
- Ensure Supabase URL is correct in frontend environment variables

