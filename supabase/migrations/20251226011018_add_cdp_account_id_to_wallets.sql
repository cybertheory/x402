-- Add cdp_account_id column to wallets table
-- This stores the CDP account ID returned from cdp.evm.createAccount() or cdp.solana.createAccount()
-- Used to identify which CDP account to use when signing transactions

ALTER TABLE wallets
ADD COLUMN IF NOT EXISTS cdp_account_id TEXT;

-- Add comment to column
COMMENT ON COLUMN wallets.cdp_account_id IS 'CDP account ID for server wallets (coinbase kind). Used to identify which account to use when signing with CDP SDK.';

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_wallets_cdp_account_id ON wallets(cdp_account_id) WHERE cdp_account_id IS NOT NULL;


