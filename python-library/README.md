# x402instant - Python Client Library

Python client library for x402Instant with automatic x402 payment handling.

## Installation

```bash
pip install x402instant
```

## Usage

### Basic Setup

```python
from x402instant import X402InstantClient

client = X402InstantClient(
    api_key='your-api-key-or-jwt',
    supabase_url='https://your-project.supabase.co',
    wallet_id='optional-default-wallet-id',
)
```

### Making Requests with Automatic Payment

The `call()` method automatically detects 402 Payment Required responses and handles payments:

```python
response = client.call(
    'https://api.example.com/protected-endpoint',
    method='GET',
    headers={
        'Content-Type': 'application/json',
    },
)

data = response.json()
```

### Manual Payment Signature Creation

You can also create payment signatures manually:

```python
from x402instant import PaymentRequired, PaymentRequirement

payment_required = PaymentRequired(
    x402_version=1,
    accepts=[
        PaymentRequirement(
            scheme='exact',
            network='base',
            asset='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            pay_to='0x...',
            max_amount_required='1000000',
        )
    ],
    resource={
        'uri': 'https://api.example.com/endpoint',
        'method': 'GET',
    },
)

signature = client.pay.create_signature(payment_required)
```

### Using a Specific Wallet

You can specify a wallet ID for individual requests:

```python
# Use specific wallet for this request
response = client.call(
    'https://api.example.com/endpoint',
    wallet_id='wallet-id-here',
)
```

## API Reference

### `X402InstantClient`

#### Constructor

```python
X402InstantClient(api_key: str, supabase_url: str, wallet_id: Optional[str] = None)
```

- `api_key`: Your API key (or JWT token)
- `supabase_url`: Your Supabase project URL
- `wallet_id`: Optional default wallet ID

#### Methods

##### `call(url: str, method: str = 'GET', headers: Optional[Dict[str, str]] = None, body: Optional[Union[str, Dict]] = None, wallet_id: Optional[str] = None) -> requests.Response`

Makes an HTTP request and automatically handles 402 payment challenges.

- `url`: The endpoint URL
- `method`: HTTP method (default: 'GET')
- `headers`: Request headers
- `body`: Request body (string or dict)
- `wallet_id`: Wallet ID to use for payment (overrides default)

##### `create_signature(payment_required: PaymentRequired, wallet_id: Optional[str] = None) -> str`

Creates a payment signature for a PaymentRequired object.

- `payment_required`: The payment requirement from a 402 response
- `wallet_id`: Optional wallet ID (uses default if not provided)

##### `pay.create_signature(payment_required: PaymentRequired, wallet_id: Optional[str] = None) -> str`

Same as `create_signature()`, provided for convenience.

## License

MIT


