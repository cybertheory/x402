# x402instant - TypeScript Client Library

TypeScript client library for x402Instant with automatic x402 payment handling.

## Installation

```bash
npm install x402instant
```

## Usage

### Basic Setup

```typescript
import { X402InstantClient } from 'x402instant';

const client = new X402InstantClient({
  apiKey: 'your-api-key-or-jwt',
  supabaseUrl: 'https://your-project.supabase.co',
  walletId: 'optional-default-wallet-id',
});
```

### Making Requests with Automatic Payment

The `call()` method automatically detects 402 Payment Required responses and handles payments:

```typescript
const response = await client.call('https://api.example.com/protected-endpoint', {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json',
  },
});

const data = await response.json();
```

### Manual Payment Signature Creation

You can also create payment signatures manually:

```typescript
const paymentRequired = {
  x402Version: 1,
  accepts: [{
    scheme: 'exact',
    network: 'base',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x...',
    maxAmountRequired: '1000000',
  }],
  resource: {
    uri: 'https://api.example.com/endpoint',
    method: 'GET',
  },
};

const signature = await client.pay.createSignature(paymentRequired);
```

### Using a Specific Wallet

You can specify a wallet ID for individual requests:

```typescript
// Use specific wallet for this request
const response = await client.call('https://api.example.com/endpoint', {
  walletId: 'wallet-id-here',
});
```

## API Reference

### `X402InstantClient`

#### Constructor

```typescript
new X402InstantClient(config: X402InstantClientConfig)
```

- `apiKey`: Your API key (or JWT token)
- `supabaseUrl`: Your Supabase project URL
- `walletId`: Optional default wallet ID

#### Methods

##### `call(url: string, options?: CallOptions): Promise<Response>`

Makes an HTTP request and automatically handles 402 payment challenges.

- `url`: The endpoint URL
- `options.method`: HTTP method (default: 'GET')
- `options.headers`: Request headers
- `options.body`: Request body (string or object)
- `options.walletId`: Wallet ID to use for payment (overrides default)

##### `createSignature(paymentRequired: PaymentRequired, walletId?: string): Promise<string>`

Creates a payment signature for a PaymentRequired object.

- `paymentRequired`: The payment requirement from a 402 response
- `walletId`: Optional wallet ID (uses default if not provided)

##### `pay.createSignature(paymentRequired: PaymentRequired, walletId?: string): Promise<string>`

Same as `createSignature()`, provided for convenience.

## License

MIT


