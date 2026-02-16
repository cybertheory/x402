"""Example script demonstrating Waterfall SDK usage."""

from waterfall import WaterfallClient, Provider, create_openrouter_client
from typing import Dict, Any


# Example custom provider implementation
class ExampleProvider(Provider):
    """Example provider that demonstrates the provider pattern."""

    def call(self, input_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Example provider call implementation.

        Args:
            input_data: Input data containing query or other parameters

        Returns:
            Response from the provider
        """
        # Extract input
        query = input_data.get("query", "")
        endpoint = input_data.get("endpoint", "/api/example")

        # Make request through x402 client utility
        # The x402 client will automatically handle payment signatures
        # when payment_required is present
        response = self._make_request("GET", endpoint)

        return response


def main():
    """Main example function."""
    # Initialize Waterfall client
    # Configure with backend URL
    client = WaterfallClient(
        backend_url="https://api.waterfall.example.com",  # Your backend URL
    )

    # Optionally configure wallet
    # Use default wallet (if wallet_id is None)
    client.configure_wallet()

    # Or use a specific wallet by ID
    # client.configure_wallet(wallet_id="wallet-123")

    # Or use a wallet by name
    # client.configure_wallet(wallet_name="my-wallet")

    try:
        # Example 1: Using custom provider
        provider = ExampleProvider(
            client=client,
            x402_base_url="https://x402-api.example.com",  # x402 API base URL
        )

        result = client.call(
            provider,
            input_data={
                "query": "example query",
                "endpoint": "/api/example",
            },
        )
        print("Custom provider response:", result)

        # Example 2: Using OpenRouter SDK natively
        # Create OpenRouter client with x402 proxy
        openrouter = create_openrouter_client(
            waterfall_client=client,
            api_key="your-openrouter-api-key",  # Optional
        )

        # Use OpenRouter providers directly - they'll route through x402 proxy
        # The x402 proxy URL is hardcoded in X402_PROXY_URL
        completion = openrouter.chat.completions.create(
            model="openai/gpt-4",
            messages=[
                {"role": "user", "content": "Hello!"}
            ]
        )
        print("OpenRouter response:", completion)

        # Example of signing data directly
        data_to_sign = b"example data"
        signature = client.sign_data(data_to_sign)
        print("Signature:", signature)

    finally:
        # Clean up
        client.close()


if __name__ == "__main__":
    main()
