"""Minimal test script for x402 payments with Waterfall SDK."""

from waterfall import WaterfallClient

# Config - tenant 3461c0ca-0924-4824-948f-34a966704532
X402_API_KEY = "x402_sdk-test-3461c0ca-v1"
WALLET_ID = "2595141d-80ae-4231-a8f6-2e03adae9ff1"  # 0x6e560Fd994dA2f434E95Cde3CAA868FB0bbCA8Ba (base mainnet)


def main():
    print("=== Waterfall SDK Test ===\n")
    
    # Initialize client with specific wallet
    client = WaterfallClient(x402_api_key=X402_API_KEY, wallet_id=WALLET_ID)
    print(f"Wallet: {client.wallet_config.wallet_id}")
    
    # Make request - x402 payment handling is automatic
    print("Calling OpenRouter via x402 proxy...")
    
    response = client.chat.send(
        model="openai/gpt-3.5-turbo",
        messages=[{"role": "user", "content": "Say hello in 3 words"}],
        max_tokens=20,
    )
    
    # Extract response
    if hasattr(response, 'choices') and response.choices:
        content = response.choices[0].message.content
    else:
        content = str(response)
    
    print(f"\nResponse: {content}")
    print("\n=== Done ===")


if __name__ == "__main__":
    main()
