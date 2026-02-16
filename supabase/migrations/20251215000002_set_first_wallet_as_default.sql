-- Function to automatically set the first wallet as default
-- This ensures that when a wallet is inserted and it's the first wallet for a tenant,
-- it automatically gets is_default=true

CREATE OR REPLACE FUNCTION set_first_wallet_as_default()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if this is the first wallet for this tenant
  IF NOT EXISTS (
    SELECT 1 FROM wallets 
    WHERE tenant_id = NEW.tenant_id 
    AND id != NEW.id
  ) THEN
    -- This is the first wallet, set it as default
    NEW.is_default = true;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger that runs before insert
DROP TRIGGER IF EXISTS trigger_set_first_wallet_as_default ON wallets;
CREATE TRIGGER trigger_set_first_wallet_as_default
  BEFORE INSERT ON wallets
  FOR EACH ROW
  EXECUTE FUNCTION set_first_wallet_as_default();

-- Optional: Add a unique partial index to ensure only one default wallet per tenant
-- This prevents multiple wallets from being marked as default
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_one_default_per_tenant 
ON wallets (tenant_id) 
WHERE is_default = true;













