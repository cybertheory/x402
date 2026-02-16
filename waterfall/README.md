# Waterfall Python SDK

Python SDK for Waterfall - an x402 payment client with server wallet integration.

## Overview

Waterfall provides a simple Python interface for interacting with x402 APIs while automatically handling payment signatures using server-side wallets. The SDK authenticates with x402Instant using API keys and abstracts away the complexity of wallet management and payment signing.

## Features

- **API Key Authentication**: Authenticate with x402Instant using API keys (`x402_...`)
- **Server Wallet Integration**: Automatically signs payment headers using configured wallets
- **Wallet Management**: List, fetch, and configure wallets via Supabase backend
- **Simple Client Interface**: Easy-to-use client for calling x402 APIs
- **Provider Pattern**: Extensible provider interface for different x402 API services
- **Automatic Payment Signing**: Handles payment signature creation transparently

## Installation

```bash
pip install waterfall
```

Or install from source:

```bash
cd waterfall
pip install -e .
```

## Quick Start

### Getting an API Key

Get your x402Instant API key from the **x402Instant dashboard**. The key format is `x402_...`.

### Using OpenRouter SDK (Recommended)

```python
from waterfall import WaterfallClient, create_openrouter_client

# Initialize Waterfall client with x402 API key
# Note: OpenRouter API key is NOT needed - it's provided by the x402 proxy
client = WaterfallClient(
    x402_api_key="x402_...",  # Your x402Instant API key (from dashboard)
)

# Configure wallet (fetches default wallet from Supabase)
client.configure_wallet()

# Or configure by wallet name
# client.configure_wallet(wallet_name="my-production-wallet")

# Create OpenRouter client with x402 proxy
openrouter = create_openrouter_client(client)

# Use OpenRouter - payments AND API key are handled automatically!
completion = openrouter.chat.completions.create(
    model="openai/gpt-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

### Listing Wallets

```python
from waterfall import WaterfallClient

client = WaterfallClient(x402_api_key="x402_...")

# List all wallets
wallets = client.wallet_manager.list_wallets()
for wallet in wallets:
    print(f"{wallet['name']}: {wallet['address']} ({wallet['chain']})")

# Get default wallet
default_id = client.wallet_manager.get_default_wallet()

# Get wallet by name
wallet_id = client.wallet_manager.get_wallet_by_name("my-wallet")
```

### Using Custom Providers

```python
from waterfall import WaterfallClient, Provider
from typing import Dict, Any

class MyProvider(Provider):
    def call(self, input_data: Dict[str, Any]) -> Dict[str, Any]:
        endpoint = input_data.get("endpoint", "/api/example")
        return self._make_request("GET", endpoint)

# Initialize client
client = WaterfallClient(
    x402_api_key="x402_...",  # For Supabase auth
)

# Configure wallet
client.configure_wallet()

# Create provider
provider = MyProvider(
    client=client,
    x402_base_url="https://your-x402-api.example.com",
)

# Call provider - automatically signs payment headers
result = client.call(provider, input_data={"endpoint": "/api/example"})
```

## Architecture

### Client Flow

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│  Your App   │────▶│ WaterfallClient│────▶│ Supabase Backend│     │ x402 Gateway │
└─────────────┘     └──────────────┘     └─────────────────┘     └──────────────┘
                           │                      │                      │
                           │ 1. configure_wallet()│                      │
                           │─────────────────────▶│                      │
                           │     (GET /wallets)   │                      │
                           │◀─────────────────────│                      │
                           │                      │                      │
                           │ 2. OpenRouter request│                      │
                           │──────────────────────┼─────────────────────▶│
                           │                      │      3. 402 Response │
                           │◀─────────────────────┼──────────────────────│
                           │                      │                      │
                           │ 4. POST /wallet-pay  │                      │
                           │─────────────────────▶│                      │
                           │      (sign payment)  │                      │
                           │◀─────────────────────│                      │
                           │                      │                      │
                           │ 5. Retry with signature                     │
                           │──────────────────────┼─────────────────────▶│
                           │                      │         6. Success   │
                           │◀─────────────────────┼──────────────────────│
```

### Components

- **WaterfallClient**: Main client interface with API key authentication
- **WalletManager**: Handles wallet operations via Supabase REST API
- **Provider**: Abstract base class for custom x402 API integrations
- **create_openrouter_client**: Factory function to create OpenRouter client with x402 proxy

### Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `x402_api_key` | x402Instant API key for Supabase auth | Required |
| `backend_url` | Supabase functions URL | `https://sbdxcdwssrzvocnkcndq.supabase.co/functions/v1` |

**Note:** OpenRouter API key is NOT required - the x402 proxy provides its own API key for all OpenRouter requests.

## Environment Variables

```bash
export X402_API_KEY="x402_..."  # Your x402Instant API key (from dashboard)
```

## Authentication

The SDK supports two authentication methods for Supabase backend calls:

1. **API Key** (recommended): Use `x402_api_key` parameter with your dashboard API key
2. **JWT Token**: Pass a Supabase JWT as the `x402_api_key` parameter

Both methods work interchangeably - the backend automatically detects the token type.

## Examples

See the `example_*.py` files for complete working examples:

- `example_with_api_key.py` - Full example using API key authentication
- `example_openrouter.py` - OpenRouter integration example

## Development

```bash
# Install development dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Format code
black waterfall/

# Type checking
mypy waterfall/
```

## License

MIT
