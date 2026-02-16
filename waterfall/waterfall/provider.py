"""Provider interface for x402 API abstractions."""

from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, TYPE_CHECKING, Union
import httpx

if TYPE_CHECKING:
    from .client import WaterfallClient
    from openrouter import OpenRouter


class Provider(ABC):
    """
    Abstract base class for x402 API providers.

    Each provider implements a specific x402 API service but follows
    the same basic pattern using the custom httpx x402 client utility.
    
    Providers can also be OpenRouter SDK clients directly, which will
    automatically use the x402 proxy URL.
    """

    def __init__(
        self,
        client: "WaterfallClient",
        x402_base_url: Optional[str] = None,
    ):
        """
        Initialize provider with Waterfall client.

        Args:
            client: WaterfallClient instance to access wallet configuration
            x402_base_url: Optional base URL for x402 API (for custom providers)
                         If None, provider should use OpenRouter SDK
        """
        self.client = client
        self.x402_base_url = x402_base_url
        
        # Create httpx client if base_url is provided
        # Otherwise, provider should use OpenRouter client
        if x402_base_url:
            self.http_client = httpx.Client(base_url=x402_base_url, timeout=30.0)
            self.backend_client = (
                httpx.Client(timeout=30.0) if client.backend_url else None
            )
        else:
            self.http_client = None
            self.backend_client = None

    @abstractmethod
    def call(self, input_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Call the provider's API endpoint.

        Args:
            input_data: Input data for the provider

        Returns:
            Response data from the provider

        Raises:
            NotImplementedError: Must be implemented by subclasses
        """
        raise NotImplementedError("Provider call method must be implemented by subclass")

    def _create_payment_signature(self, payment_required: Dict[str, Any]) -> str:
        """
        Create payment signature via backend wallet-pay endpoint.

        Args:
            payment_required: Payment required object

        Returns:
            Payment signature string
        """
        if not self.client.backend_url:
            raise ValueError("Backend URL is required for payment signature creation")
        if not self.backend_client:
            self.backend_client = httpx.Client(timeout=30.0)

        payload: Dict[str, Any] = {"paymentRequired": payment_required}
        if self.client.wallet_config.wallet_id:
            payload["wallet_id"] = self.client.wallet_config.wallet_id

        # Build headers with authorization if x402 API key is configured
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if self.client.x402_api_key:
            headers["Authorization"] = f"Bearer {self.client.x402_api_key}"

        response = self.backend_client.post(
            f"{self.client.backend_url}/wallet-pay",
            json=payload,
            headers=headers,
        )
        response.raise_for_status()
        result = response.json()

        if not result.get("success"):
            raise ValueError(f"Failed to create payment signature: {result.get('error')}")

        return result.get("signature") or result.get("payment_signature")

    def _make_request(
        self,
        method: str,
        endpoint: str,
        payment_required: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        Helper method to make HTTP requests with x402 payment signature support.

        Args:
            method: HTTP method
            endpoint: API endpoint path
            payment_required: Optional payment required object
            **kwargs: Additional request arguments

        Returns:
            JSON response as dictionary
        """
        if not self.http_client:
            raise ValueError("http_client not initialized. Provide x402_base_url or use OpenRouter client.")
        
        headers = kwargs.pop("headers", {}) or {}
        
        # If payment_required is provided, create and add payment signature
        if payment_required:
            signature = self._create_payment_signature(payment_required)
            headers["payment-signature"] = signature
        
        kwargs["headers"] = headers
        response = self.http_client.request(method, endpoint, **kwargs)
        response.raise_for_status()
        return response.json()
