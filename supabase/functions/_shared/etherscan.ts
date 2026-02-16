// etherscan.ts
// Etherscan API V2 (unified endpoint) — correct BigInt handling + global rate limiting + caching + inflight de-dupe
//
// Key improvements vs your pasted version:
// - Uses V2 unified endpoint + chainid correctly (https://api.etherscan.io/v2/api)  ✅
// - Correct balance + tx amount formatting (NO Number(BigInt), NO BigInt division truncation) ✅
// - Global per-API-key rate limiter (token bucket) + backoff on rate-limit responses ✅
// - Inflight request coalescing + small TTL cache to reduce bursts ✅
// - Treats "no transactions found" as empty result, not a hard failure ✅
//
// Tunables (env):
// - ETHERSCAN_RPS (default 3)             // Free tier is 3 calls/sec per key
// - ETHERSCAN_CONCURRENCY (default 2)
// - ETHERSCAN_CACHE_TTL_MS (default 15000)
// - ETHERSCAN_RETRY_MAX (default 4)

export type Balance = {
  wallet_id: string;
  wallet_address: string;
  chain: string;
  token_symbol: string;
  token_address: string | null;
  amount: string; // decimal string
  decimals: number;
  is_native: boolean;
};

export type Transaction = {
  hash: string;
  from: string;
  to: string;
  amount: string; // decimal string
  token_symbol: string;
  token_address: string | null;
  chain: string;
  timestamp: number; // ms
  block_number?: number;
  status: "success" | "failed" | "pending";
  direction: "to" | "from";
};

// -------------------------
// Chain config
// -------------------------
const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  "base-sepolia": 84532,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
};

const ETHERSCAN_V2_API = "https://api.etherscan.io/v2/api";

// USDC addresses by chain (your same set)
const USDC_ADDRESSES: Record<string, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
};

// -------------------------
// Public helpers (same idea as your file)
// -------------------------
export function getExplorerApiUrl(chain: string): string | null {
  return getChainId(chain) ? ETHERSCAN_V2_API : null;
}

export function getChainId(chain: string): number | null {
  return CHAIN_IDS[chain] ?? null;
}

export function getExplorerApiKey(_chain: string): string | null {
  return Deno.env.get("ETHERSCAN_API_KEY") || null;
}

export function isEtherscanSupported(chain: string): boolean {
  return chain !== "solana" && getChainId(chain) !== null;
}

function getNativeTokenSymbol(chain: string): string {
  if (chain === "solana") return "SOL";
  return "ETH";
}

// -------------------------
// BigInt-safe formatting (no precision loss)
// -------------------------
function formatUnits(value: bigint, decimals: number): string {
  if (!Number.isFinite(decimals) || decimals <= 0) return value.toString();

  const base = 10n ** BigInt(decimals);
  const neg = value < 0n;
  const v = neg ? -value : value;

  const whole = v / base;
  const frac = v % base;

  if (frac === 0n) return (neg ? "-" : "") + whole.toString();

  let fracStr = frac.toString().padStart(decimals, "0");
  fracStr = fracStr.replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
}

// -------------------------
// Rate limiting + caching + inflight de-dupe
// -------------------------
const ETHERSCAN_RPS = Math.max(1, Number(Deno.env.get("ETHERSCAN_RPS") ?? "3"));
const ETHERSCAN_CONCURRENCY = Math.max(
  1,
  Number(Deno.env.get("ETHERSCAN_CONCURRENCY") ?? "2"),
);
const ETHERSCAN_CACHE_TTL_MS = Math.max(
  0,
  Number(Deno.env.get("ETHERSCAN_CACHE_TTL_MS") ?? "15000"),
);
const ETHERSCAN_RETRY_MAX = Math.max(
  1,
  Number(Deno.env.get("ETHERSCAN_RETRY_MAX") ?? "4"),
);

type CacheEntry = { expiresAt: number; value: unknown };

class TokenBucketLimiter {
  private tokens: number;
  private lastRefill: number;
  private inFlight = 0;
  private queue: Array<{
    run: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];

  constructor(
    private readonly rps: number,
    private readonly concurrency: number,
  ) {
    this.tokens = rps;
    this.lastRefill = Date.now();
    setInterval(() => this.refill(), 250).unref?.();
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.rps, this.tokens + (elapsed / 1000) * this.rps);
    this.lastRefill = now;
    this.drain();
  }

  private drain() {
    while (
      this.queue.length > 0 &&
      this.inFlight < this.concurrency &&
      this.tokens >= 1
    ) {
      const item = this.queue.shift()!;
      this.tokens -= 1;
      this.inFlight += 1;

      item
        .run()
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          this.inFlight -= 1;
          this.drain();
        });
    }
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: fn as unknown as () => Promise<unknown>,
        resolve: resolve as unknown as (v: unknown) => void,
        reject,
      });
      this.drain();
    });
  }
}

const limitersByKey = new Map<string, TokenBucketLimiter>();
const inflight = new Map<string, Promise<unknown>>();
const cache = new Map<string, CacheEntry>();

function getLimiterFor(apiKey: string | null): TokenBucketLimiter {
  const key = (apiKey?.trim() || "__no_key__").toLowerCase();
  let limiter = limitersByKey.get(key);
  if (!limiter) {
    limiter = new TokenBucketLimiter(ETHERSCAN_RPS, ETHERSCAN_CONCURRENCY);
    limitersByKey.set(key, limiter);
  }
  return limiter;
}

function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
}

function cacheSet(key: string, value: unknown, ttlMs = ETHERSCAN_CACHE_TTL_MS) {
  if (ttlMs <= 0) return;
  cache.set(key, { expiresAt: Date.now() + ttlMs, value });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRateLimited(respStatus: number, data: any): boolean {
  if (respStatus === 429) return true;
  const msg = String(data?.message ?? "").toLowerCase();
  const result = String(data?.result ?? "").toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("max rate limit") ||
    result.includes("rate limit") ||
    result.includes("max rate limit")
  );
}

type EtherscanV2Response<T> = {
  status: string; // "1" success, "0" not found / no data, etc.
  message?: string;
  result: T;
};

async function fetchEtherscanJson<T>(
  url: string,
  apiKey: string | null,
  cacheKey: string,
  ttlMs?: number,
): Promise<T> {
  const cached = cacheGet<T>(cacheKey);
  if (cached !== null) return cached;

  const existing = inflight.get(cacheKey);
  if (existing) return (await existing) as T;

  const limiter = getLimiterFor(apiKey);

  const promise = limiter.schedule(async () => {
    for (let attempt = 1; attempt <= ETHERSCAN_RETRY_MAX; attempt++) {
      const resp = await fetch(url);
      const text = await resp.text();

      let data: any;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(
          `[etherscan] Non-JSON response (HTTP ${resp.status}): ${text.slice(
            0,
            200,
          )}`,
        );
      }

      const rateLimited = isRateLimited(resp.status, data);

      if (!resp.ok || rateLimited) {
        if (rateLimited && attempt < ETHERSCAN_RETRY_MAX) {
          const backoff = Math.min(15_000, 500 * 2 ** (attempt - 1));
          const jitter = Math.floor(Math.random() * 250);
          await sleep(backoff + jitter);
          continue;
        }
        throw new Error(
          `[etherscan] HTTP ${resp.status}: ${data?.message ?? resp.statusText} (${
            typeof data?.result === "string"
              ? data.result.slice(0, 200)
              : "non-string result"
          })`,
        );
      }

      cacheSet(cacheKey, data as T, ttlMs);
      return data as T;
    }

    throw new Error("[etherscan] exhausted retries");
  });

  inflight.set(cacheKey, promise);
  try {
    return (await promise) as T;
  } finally {
    inflight.delete(cacheKey);
  }
}

function buildUrl(
  chainId: number,
  params: Record<string, string>,
  apiKey: string | null,
): string {
  const qs = new URLSearchParams({
    chainid: chainId.toString(),
    ...params,
    ...(apiKey ? { apikey: apiKey } : {}),
  });
  return `${ETHERSCAN_V2_API}?${qs.toString()}`;
}

// -------------------------
// Balances
// -------------------------
export async function fetchNativeBalance(
  address: string,
  chain: string,
): Promise<string> {
  const chainId = getChainId(chain);
  if (!chainId) throw new Error(`Unsupported chain for Etherscan API: ${chain}`);

  const apiKey = getExplorerApiKey(chain);

  const url = buildUrl(
    chainId,
    {
      module: "account",
      action: "balance",
      address,
      tag: "latest",
    },
    apiKey,
  );

  const cacheKey = `balance:native:${chainId}:${address.toLowerCase()}`;

  try {
    const data = await fetchEtherscanJson<EtherscanV2Response<string>>(
      url,
      apiKey,
      cacheKey,
      10_000,
    );

    // V2 returns result as a string wei value; status can be "0" with result "0"
    const wei = BigInt(String(data?.result ?? "0").trim() || "0");
    return formatUnits(wei, 18);
  } catch (e) {
    console.error("[etherscan] fetchNativeBalance failed:", e);
    return "0";
  }
}

async function fetchTokenBalance(
  address: string,
  tokenAddress: string,
  chain: string,
  decimals: number,
): Promise<string> {
  const chainId = getChainId(chain);
  if (!chainId) throw new Error(`Unsupported chain: ${chain}`);

  const apiKey = getExplorerApiKey(chain);
  if (!apiKey) throw new Error("Missing ETHERSCAN_API_KEY");

  const url = buildUrl(
    chainId,
    {
      module: "account",
      action: "tokenbalance",
      contractaddress: tokenAddress,
      address,
      tag: "latest",
    },
    apiKey,
  );

  const cacheKey = `balance:token:${chainId}:${address.toLowerCase()}:${tokenAddress.toLowerCase()}`;

  const data = await fetchEtherscanJson<EtherscanV2Response<string>>(
    url,
    apiKey,
    cacheKey,
    10_000,
  );

  const raw = BigInt(String(data?.result ?? "0").trim() || "0");
  return formatUnits(raw, decimals);
}

export async function fetchTokenBalances(
  address: string,
  chain: string,
  walletId: string,
): Promise<Balance[]> {
  const usdcAddress = USDC_ADDRESSES[chain];

  // Always include USDC entry (even when chain not configured)
  if (!usdcAddress) {
    return [
      {
        wallet_id: walletId,
        wallet_address: address,
        chain,
        token_symbol: "USDC",
        token_address: null,
        amount: "0",
        decimals: 6,
        is_native: false,
      },
    ];
  }

  try {
    const amt = await fetchTokenBalance(address, usdcAddress, chain, 6);
    return [
      {
        wallet_id: walletId,
        wallet_address: address,
        chain,
        token_symbol: "USDC",
        token_address: usdcAddress,
        amount: amt,
        decimals: 6,
        is_native: false,
      },
    ];
  } catch (e) {
    console.error("[etherscan] fetchTokenBalances(USDC) failed:", e);
    return [
      {
        wallet_id: walletId,
        wallet_address: address,
        chain,
        token_symbol: "USDC",
        token_address: usdcAddress,
        amount: "0",
        decimals: 6,
        is_native: false,
      },
    ];
  }
}

// -------------------------
// Transactions
// -------------------------
type TxListItem = {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  blockNumber: string;
  isError?: string;
};

type TokenTxItem = {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  blockNumber: string;
  tokenDecimal: string;
  tokenSymbol?: string;
  contractAddress?: string;
};

function txDirection(
  address: string,
  from: string | undefined,
  to: string | undefined,
): "to" | "from" | null {
  const a = address.toLowerCase();
  if (to?.toLowerCase() === a) return "to";
  if (from?.toLowerCase() === a) return "from";
  return null;
}

export async function fetchTransactions(
  address: string,
  chain: string,
  direction: "to" | "from",
  limit: number,
  offset: number,
): Promise<Transaction[]> {
  const chainId = getChainId(chain);
  if (!chainId) throw new Error(`Unsupported chain for Etherscan API: ${chain}`);

  const apiKey = getExplorerApiKey(chain);

  // Etherscan pagination is page+offset (offset = page size)
  const page = Math.floor(offset / limit) + 1;

  // Fetch extra because we filter by direction after merging txlist+tokentx
  const fetchCount = Math.min(200, Math.max(limit * 2, limit));

  const common = {
    module: "account",
    address,
    startblock: "0",
    endblock: "9999999999",
    page: String(page),
    offset: String(fetchCount),
    sort: "desc",
  };

  const txlistUrl = buildUrl(chainId, { ...common, action: "txlist" }, apiKey);
  const tokentxUrl = buildUrl(chainId, { ...common, action: "tokentx" }, apiKey);

  const txlistKey = `tx:txlist:${chainId}:${address.toLowerCase()}:p${page}:n${fetchCount}`;
  const tokentxKey = `tx:tokentx:${chainId}:${address.toLowerCase()}:p${page}:n${fetchCount}`;

  const [nativeRes, tokenRes] = await Promise.allSettled([
    fetchEtherscanJson<EtherscanV2Response<TxListItem[]>>(
      txlistUrl,
      apiKey,
      txlistKey,
      20_000,
    ),
    fetchEtherscanJson<EtherscanV2Response<TokenTxItem[]>>(
      tokentxUrl,
      apiKey,
      tokentxKey,
      20_000,
    ),
  ]);

  const merged: Transaction[] = [];

  // Native
  if (nativeRes.status === "fulfilled") {
    const data = nativeRes.value;
    const list = Array.isArray(data?.result) ? data.result : [];

    // NOTE: status "0" + message "No transactions found" => treat as empty list
    for (const tx of list) {
      const dir = txDirection(address, tx.from, tx.to);
      if (dir !== direction) continue;

      const wei = BigInt(String(tx.value ?? "0"));
      const timestamp = Number.parseInt(tx.timeStamp ?? "0", 10) * 1000;

      merged.push({
        hash: tx.hash,
        from: tx.from || "",
        to: tx.to || "",
        amount: formatUnits(wei, 18),
        token_symbol: getNativeTokenSymbol(chain),
        token_address: null,
        chain,
        timestamp,
        block_number: Number.parseInt(tx.blockNumber ?? "0", 10),
        status: tx.isError === "1" ? "failed" : "success",
        direction: dir,
      });
    }
  } else {
    console.warn("[etherscan] txlist failed:", nativeRes.reason);
  }

  // ERC-20 transfers
  if (tokenRes.status === "fulfilled") {
    const data = tokenRes.value;
    const list = Array.isArray(data?.result) ? data.result : [];

    for (const tx of list) {
      const dir = txDirection(address, tx.from, tx.to);
      if (dir !== direction) continue;

      const decimals = Number.parseInt(tx.tokenDecimal ?? "18", 10);
      const raw = BigInt(String(tx.value ?? "0"));
      const timestamp = Number.parseInt(tx.timeStamp ?? "0", 10) * 1000;

      merged.push({
        hash: tx.hash,
        from: tx.from || "",
        to: tx.to || "",
        amount: formatUnits(raw, Number.isFinite(decimals) ? decimals : 18),
        token_symbol: tx.tokenSymbol || "TOKEN",
        token_address: tx.contractAddress || null,
        chain,
        timestamp,
        block_number: Number.parseInt(tx.blockNumber ?? "0", 10),
        status: "success",
        direction: dir,
      });
    }
  } else {
    console.warn("[etherscan] tokentx failed:", tokenRes.reason);
  }

  // Merge + sort + limit
  merged.sort((a, b) => b.timestamp - a.timestamp);
  return merged.slice(0, limit);
}

// -------------------------
// (Optional) Efficiency booster if you ever fetch many native balances at once
// Etherscan balance endpoint supports up to 20 comma-separated addresses per call.
// If your aggregator loads lots of wallets, use this to cut calls dramatically.
// -------------------------
export async function fetchNativeBalancesBatch(
  addresses: string[],
  chain: string,
): Promise<Record<string, string>> {
  const chainId = getChainId(chain);
  if (!chainId) throw new Error(`Unsupported chain: ${chain}`);

  const apiKey = getExplorerApiKey(chain);
  const out: Record<string, string> = {};

  // chunk to 20 per docs
  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += 20) {
    chunks.push(addresses.slice(i, i + 20));
  }

  for (const chunk of chunks) {
    const joined = chunk.join(",");
    const url = buildUrl(
      chainId,
      { module: "account", action: "balance", address: joined, tag: "latest" },
      apiKey,
    );

    const key = `balance:native-batch:${chainId}:${joined.toLowerCase()}`;

    const data = await fetchEtherscanJson<EtherscanV2Response<any>>(
      url,
      apiKey,
      key,
      10_000,
    );

    // When multiple addresses are requested, Etherscan returns an array of {account,balance}
    if (Array.isArray(data?.result)) {
      for (const row of data.result) {
        const acct = String(row?.account ?? "").toLowerCase();
        const wei = BigInt(String(row?.balance ?? "0"));
        if (acct) out[acct] = formatUnits(wei, 18);
      }
    } else {
      // single string fallback
      if (chunk.length === 1) {
        out[chunk[0].toLowerCase()] = formatUnits(
          BigInt(String(data?.result ?? "0")),
          18,
        );
      }
    }
  }

  return out;
}
