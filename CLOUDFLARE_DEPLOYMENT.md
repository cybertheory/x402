# Cloudflare Worker Deployment Checklist

## 1. Install Dependencies & Copy Worker Code

### If using Wrangler CLI:
```bash
npm install @noble/curves @noble/hashes
```

### Copy Worker Code
- Copy the entire contents of `worker.js` into your Cloudflare Worker
- Via Dashboard: Workers & Pages → Your Worker → Edit code → paste
- Via Wrangler CLI: paste into `src/index.js` or `worker.js`

**Important**: The worker uses `@noble/curves` and `@noble/hashes` npm packages. 
- If deploying via **Dashboard**: Cloudflare will automatically bundle npm packages, but make sure the imports use standard npm syntax (already fixed in worker.js)
- If deploying via **Wrangler CLI**: Run `npm install` first to ensure packages are available

## 2. Required KV Namespace Bindings

### `TENANTS` (Required)
- **Binding name**: `TENANTS`
- **Purpose**: Stores tenant configs keyed by `cfg:${hostname}`
- **How to bind**:
  - Dashboard: Workers & Pages → Your Worker → Settings → Variables → KV Namespace Bindings → Add binding
  - Name: `TENANTS`
  - KV Namespace: Select/create a namespace (e.g., "tenants")
  - Or via `wrangler.toml`:
    ```toml
    [[kv_namespaces]]
    binding = "TENANTS"
    id = "your-namespace-id"
    ```

### `NONCES` (Recommended, Optional)
- **Binding name**: `NONCES`
- **Purpose**: Replay protection for payments (prevents double-spending)
- **How to bind**: Same as above, create a separate KV namespace
  ```toml
  [[kv_namespaces]]
  binding = "NONCES"
  id = "your-nonces-namespace-id"
  ```
- **Note**: Worker will still function without this, but replay protection will be disabled

## 3. Required Environment Variables / Secrets

### CDP API Credentials (Required)
These are used to authenticate with Coinbase CDP facilitator:

- **`CDP_API_KEY_ID`**
  - Your Coinbase CDP API Key ID
  - Set as: **Secret** (not plain env var)
  - Dashboard: Workers & Pages → Your Worker → Settings → Variables → Environment Variables → Add variable → **Encrypt** checkbox
  
- **`CDP_API_KEY_SECRET`**
  - Your Coinbase CDP API Key Secret (base64-encoded 32-byte Ed25519 private key)
  - Set as: **Secret** (not plain env var)
  - Dashboard: Same as above, make sure **Encrypt** is checked

**Via Wrangler CLI:**
```bash
wrangler secret put CDP_API_KEY_ID
wrangler secret put CDP_API_KEY_SECRET
```

### Optional: Asset Defaults (Fallbacks)
These are only used if not specified in tenant KV config:

- **`EVM_USDC_ADDRESS`** (Optional)
  - Default USDC contract address for EVM chains (Base, Ethereum, Sepolia)
  - Default: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base USDC)
  - Can be set as plain env var or secret

- **`SOL_USDC_MINT`** (Optional)
  - Default USDC mint address for Solana
  - Default: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (Solana USDC)
  - Can be set as plain env var or secret

- **`ASSET_DECIMALS`** (Optional)
  - Default decimals for USDC (usually 6)
  - Default: `6`
  - Can be set as plain env var

## 4. Deploy the Worker

### Via Dashboard:
1. Click **Save and Deploy** after pasting code
2. Ensure all bindings and secrets are configured before deploying

### Via Wrangler CLI:
```bash
# Install Wrangler if needed
npm install -g wrangler

# Login
wrangler login

# Deploy
wrangler deploy
```

## 5. Configure Routes / Custom Domains

After deployment, configure your worker to handle requests:

- **Custom Domain**: Workers & Pages → Your Worker → Settings → Triggers → Custom Domains → Add
- **Route**: Workers & Pages → Your Worker → Settings → Triggers → Routes → Add route pattern (e.g., `*.yourdomain.com/*`)

## 6. Sync Tenant Configs to KV

Your `kv_sync_worker` Supabase Edge Function writes tenant configs to Cloudflare KV. Make sure:

1. **KV namespace ID matches**: The namespace ID used by `kv_sync_worker` (via `CLOUDFLARE_KV_NAMESPACE_ID` env var) matches the `TENANTS` binding namespace ID
2. **Keys format**: Configs are written as `cfg:${hostname}` (e.g., `cfg:example.com`, `cfg:tenant1.x402instant.com`)
3. **Test sync**: Call your `kv_sync_worker` function to sync a tenant, then verify in Cloudflare Dashboard → Workers KV → Your namespace → see the `cfg:*` keys

## 7. Test the Worker

1. **Test without payment**: Make a request to a route without pricing → should proxy to origin
2. **Test 402 response**: Make a request to a priced route without `PAYMENT-SIGNATURE` → should return 402 with `PAYMENT-REQUIRED` header
3. **Test payment flow**: Make a request with valid `PAYMENT-SIGNATURE` → should verify via CDP facilitator and proxy to origin

## Troubleshooting

### "Unknown tenant" (404)
- Check that tenant config exists in KV at key `cfg:${hostname}`
- Verify `TENANTS` KV binding is correct
- Run `kv_sync_worker` to sync tenant configs

### "CDP credentials not configured" (500)
- Verify `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` are set as **secrets** (encrypted)
- Check that secrets are deployed (not just saved in draft)

### "Origin not configured" (500)
- Check tenant KV config has `origin.url` field
- Verify `kv_sync_worker` is writing origin config correctly

### Payment verification fails
- Check CDP API credentials are valid
- Verify CDP facilitator endpoints are accessible from Cloudflare Workers
- Check worker logs in Dashboard → Workers & Pages → Your Worker → Logs

## Example `wrangler.toml` (if using CLI)

```toml
name = "x402-worker"
main = "worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "TENANTS"
id = "your-tenants-namespace-id"

[[kv_namespaces]]
binding = "NONCES"
id = "your-nonces-namespace-id"

# Secrets are set via `wrangler secret put`, not in toml
```

