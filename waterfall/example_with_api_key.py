"""Example: Using Waterfall SDK with x402Instant API keys for authentication.

This example demonstrates:
1. Using API keys (obtained from x402Instant dashboard) to authenticate
2. Listing and configuring wallets via Supabase backend
3. Making requests with automatic payment handling

Note: 
- API keys are created from the x402Instant dashboard
- OpenRouter API key is NOT needed - the x402 proxy provides it automatically
"""

import os
from waterfall import WaterfallClient, create_openrouter_client


def list_wallets_example(x402_api_key: str):
    """
    Example: List wallets using the x402 API key.
    
    Args:
        x402_api_key: Your x402Instant API key (x402_...)
    """
    print("\n--- List Wallets Example ---")
    
    client = WaterfallClient(x402_api_key=x402_api_key)
    
    try:
        # List all wallets
        wallets = client.wallet_manager.list_wallets()
        print(f"Found {len(wallets)} wallet(s):")
        for wallet in wallets:
            default_marker = " (default)" if wallet.get("is_default") else ""
            print(f"  - {wallet['name']}: {wallet['address'][:10]}...{wallet['address'][-6:]}{default_marker}")
            print(f"    Chain: {wallet['chain']}, ID: {wallet['id']}")
        
        # Get default wallet
        default_wallet_id = client.wallet_manager.get_default_wallet()
        if default_wallet_id:
            print(f"\nDefault wallet ID: {default_wallet_id}")
        else:
            print("\nNo default wallet configured")
            
    except Exception as e:
        print(f"Error listing wallets: {e}")
    finally:
        client.wallet_manager.close()


def openrouter_example(x402_api_key: str):
    """
    Example: Call OpenRouter models with x402 payments.
    
    Note: OpenRouter API key is NOT needed - the x402 proxy provides it.
    
    Args:
        x402_api_key: Your x402Instant API key (x402_...)
    """
    print("\n--- OpenRouter Example ---")
    
    # Initialize client with just the x402 API key
    # OpenRouter API key is provided by the x402 proxy automatically
    client = WaterfallClient(
        x402_api_key=x402_api_key,  # For authenticating with x402Instant backend
    )
    
    try:
        # Configure wallet (uses default if no args)
        # This fetches the default wallet from Supabase using the API key
        client.configure_wallet()
        print(f"Configured wallet: {client.wallet_config.wallet_id or 'default'}")
        
        # Create OpenRouter client with x402 proxy
        openrouter = create_openrouter_client(client)
        
        # Make a request - 402 payments AND OpenRouter API key are handled automatically!
        print("\nCalling GPT-3.5-turbo through x402 proxy...")
        completion = openrouter.chat.completions.create(
            model="openai/gpt-3.5-turbo",
            messages=[
                {"role": "user", "content": "What is x402? Answer in one sentence."}
            ],
            max_tokens=100,
        )
        
        print(f"Response: {completion.choices[0].message.content}")
        print(f"Model: {completion.model}")
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        client.close()


def configure_wallet_by_name_example(x402_api_key: str, wallet_name: str):
    """
    Example: Configure wallet by name instead of ID.
    
    Args:
        x402_api_key: Your x402Instant API key (x402_...)
        wallet_name: Name of the wallet to use
    """
    print(f"\n--- Configure Wallet by Name: '{wallet_name}' ---")
    
    client = WaterfallClient(x402_api_key=x402_api_key)
    
    try:
        # This will look up the wallet by name from Supabase
        client.configure_wallet(wallet_name=wallet_name)
        print(f"Successfully configured wallet: {client.wallet_config.wallet_id}")
        
        # Get wallet details
        wallet = client.wallet_manager.get_wallet(client.wallet_config.wallet_id)
        if wallet:
            print(f"  Address: {wallet['address']}")
            print(f"  Chain: {wallet['chain']}")
            
    except ValueError as e:
        print(f"Wallet not found: {e}")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        client.wallet_manager.close()


def main():
    """
    Main example demonstrating all features.
    
    Environment variables required:
    - X402_API_KEY: Your x402Instant API key (x402_...) - get from dashboard
    
    Note: OpenRouter API key is NOT needed - provided by x402 proxy
    """
    
    print("=" * 60)
    print("Waterfall SDK - x402Instant API Key Integration Example")
    print("=" * 60)
    
    # Get API key from environment
    x402_api_key = os.environ.get("X402_API_KEY")
    
    if not x402_api_key:
        print("\nError: X402_API_KEY environment variable not set.")
        print("Get your API key from the x402Instant dashboard.")
        print("\nUsage:")
        print("  export X402_API_KEY='x402_...'")
        print("  python example_with_api_key.py")
        return
    
    # Example 1: List wallets
    list_wallets_example(x402_api_key)
    
    # Example 2: Configure wallet by name
    # Uncomment and set your wallet name:
    # configure_wallet_by_name_example(x402_api_key, "my-wallet-name")
    
    # Example 3: OpenRouter with x402 payments
    # No OpenRouter API key needed - the x402 proxy provides it!
    openrouter_example(x402_api_key)
    
    print("\n" + "=" * 60)
    print("Examples complete!")
    print("=" * 60)


if __name__ == "__main__":
    main()
