-- Add unique constraints to prevent duplicates at the database level

-- Origins: Each tenant can only have one origin with the same URL
CREATE UNIQUE INDEX IF NOT EXISTS idx_origins_unique_url_per_tenant 
ON origins (tenant_id, url);

-- Routes: Each tenant can only have one route with the same path_prefix
CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_unique_path_per_tenant 
ON routes (tenant_id, path_prefix);

-- Wallets: Each tenant can only have one wallet with the same address and chain combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_unique_address_chain_per_tenant 
ON wallets (tenant_id, address, chain);













