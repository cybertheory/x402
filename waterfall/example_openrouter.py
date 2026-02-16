"""Example: Using Waterfall client to call OpenRouter models with x402 payments.

Note: OpenRouter API key is NOT needed - the x402 proxy provides it automatically.
"""

import os
from waterfall import WaterfallClient, create_openrouter_client


def main():
    """
    Example demonstrating how to use Waterfall client with OpenRouter models.
    
    The flow:
    1. Create Waterfall client with x402 API key
    2. Configure wallet (default or specific wallet)
    3. Create OpenRouter client (routes through x402 proxy)
    4. Call OpenRouter models - x402 payments AND API key handled automatically
    
    Environment variables:
    - X402_API_KEY: Your x402Instant API key (x402_...)
    
    Note: OpenRouter API key is NOT needed - provided by the x402 proxy
    """
    
    # Get API key from environment
    x402_api_key = os.environ.get("X402_API_KEY")
    
    if not x402_api_key:
        print("Error: X402_API_KEY environment variable not set")
        print("Get an API key from the x402Instant dashboard")
        return
    
    # Step 1: Initialize Waterfall client
    # Only x402_api_key is needed - OpenRouter API key is provided by the proxy
    client = WaterfallClient(
        x402_api_key=x402_api_key,  # Your x402Instant API key
    )
    
    # Step 2: Configure wallet
    # Option A: Use default wallet (if wallet_id is None, backend uses default)
    client.configure_wallet()
    
    # Option B: Use specific wallet by ID
    # client.configure_wallet(wallet_id="wallet-abc123")
    
    # Option C: Use wallet by name
    # client.configure_wallet(wallet_name="my-main-wallet")
    
    try:
        # Step 3: Create OpenRouter client with x402 proxy
        # This client automatically routes through x402 proxy
        # The proxy provides the OpenRouter API key automatically
        openrouter = create_openrouter_client(
            waterfall_client=client,
            # x402_proxy_url="https://custom-proxy.example.com",  # Optional: override default
        )
        
        # Step 4: Call OpenRouter models - x402 payments AND API key handled automatically!
        # When the x402 proxy returns a 402 Payment Required response:
        # 1. The wrapper extracts the payment_required object
        # 2. Calls your backend /wallet-pay endpoint to create signature
        # 3. Retries the request with payment-signature header
        # 4. Returns the model response
        
        print("Calling GPT-4 through x402 proxy...")
        completion = openrouter.chat.completions.create(
            model="openai/gpt-4",
            messages=[
                {"role": "user", "content": "Hello! Explain x402 payments in one sentence."}
            ],
            max_tokens=100,
        )
        
        print(f"Response: {completion.choices[0].message.content}")
        print(f"Model: {completion.model}")
        print(f"Usage: {completion.usage}")
        
        # Example with different model
        print("\nCalling Claude through x402 proxy...")
        completion2 = openrouter.chat.completions.create(
            model="anthropic/claude-3-opus",
            messages=[
                {"role": "user", "content": "What is Waterfall?"}
            ],
        )
        
        print(f"Response: {completion2.choices[0].message.content}")
        
        # Streaming example
        print("\nStreaming response...")
        stream = openrouter.chat.completions.create(
            model="openai/gpt-3.5-turbo",
            messages=[
                {"role": "user", "content": "Count to 5"}
            ],
            stream=True,
        )
        
        for chunk in stream:
            if chunk.choices[0].delta.content:
                print(chunk.choices[0].delta.content, end="", flush=True)
        print()  # New line after stream
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        # Clean up
        client.close()


if __name__ == "__main__":
    main()
