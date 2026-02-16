# Circle API Key Information

## Do You Need a Specific "Mint" API Key?

**No, you don't need a specific "Circle Mint API key".** Any Circle API Key will work, but it must be:

1. **A Testnet API Key** - Must be designated for testnet use (not mainnet)
2. **Standard API Key Type** - You can use a standard Circle API Key
3. **Proper Permissions** - Should have faucet/developer permissions

## How to Get a Circle API Key

1. **Sign up/Login**: Go to https://console.circle.com/signup
2. **Navigate**: API & Client Keys section
3. **Create Key**: Click "Create a key" → Select "API Key"
4. **Choose Type**: 
   - "Standard" for full access (recommended for testing)
   - "Restricted Access" if you want to limit permissions
5. **Testnet**: Ensure it's for testnet use
6. **Copy Key**: Store it securely (won't be shown again)

## Setting the API Key in Supabase

### For Production (Cloud)
```bash
supabase secrets set CIRCLE_FAUCET_API_KEY=your-api-key-here
```

### For Local Development
```bash
cd supabase
supabase secrets set CIRCLE_FAUCET_API_KEY=your-api-key-here
```

### Via Supabase Dashboard
1. Go to: Project Settings → Edge Functions → Secrets
2. Add: `CIRCLE_FAUCET_API_KEY` = your key value
3. Click Save

## Important Notes

1. **Environment Variables in Supabase Edge Functions**:
   - Supabase Edge Functions use `Deno.env.get()` to read secrets
   - These are set via `supabase secrets set` command, NOT from `.env` files
   - Local `.env` files are for frontend apps only, not Edge Functions

2. **API Key Format**:
   - Circle uses: `Bearer TEST_API_KEY:your_api_key`
   - The function automatically formats it correctly

3. **Testnet vs Mainnet**:
   - Use a **testnet** API key for Base Sepolia
   - Mainnet keys won't work for testnet faucet

## Verification

After setting the secret, you can verify it's set:
```bash
supabase secrets list
```

You should see `CIRCLE_FAUCET_API_KEY` in the list (value is hidden for security).








