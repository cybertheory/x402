"""Waterfall client - OpenRouter with x402 payment integration."""

from typing import Optional, Dict, Any, List
from openrouter import OpenRouter
import httpx

from .wallet import WalletConfig, WalletManager

# Default Supabase functions URL for x402Instant
DEFAULT_BACKEND_URL = "https://sbdxcdwssrzvocnkcndq.supabase.co/functions/v1"

# Default x402 proxy URL for OpenRouter
X402_PROXY_URL = "https://rishabhspro.x402instant.com"


class _X402HttpClient(httpx.Client):
    """
    Custom httpx.Client that automatically handles x402 Payment Required responses.
    """
    
    def __init__(self, waterfall_client: "WaterfallClient", **kwargs):
        super().__init__(**kwargs)
        self._waterfall = waterfall_client
        self._backend_client: Optional[httpx.Client] = None
    
    def _get_backend_client(self) -> httpx.Client:
        if self._backend_client is None:
            self._backend_client = httpx.Client(timeout=30.0)
        return self._backend_client
    
    def _sign_payment(self, payment_required: Dict[str, Any]) -> str:
        """Create payment signature via backend wallet-pay endpoint."""
        payload: Dict[str, Any] = {"paymentRequired": payment_required}
        
        if self._waterfall.wallet_config.wallet_id:
            payload["wallet_id"] = self._waterfall.wallet_config.wallet_id

        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if self._waterfall.x402_api_key:
            headers["Authorization"] = f"Bearer {self._waterfall.x402_api_key}"

        url = f"{self._waterfall.backend_url}/wallet-pay"
        response = self._get_backend_client().post(url, json=payload, headers=headers)
        
        if response.status_code != 200:
            raise ValueError(f"Payment failed: {response.status_code} - {response.text}")
        
        result = response.json()
        if not result.get("success"):
            raise ValueError(f"Payment signing failed: {result.get('error')}")

        return result.get("signature") or result.get("payment_signature")
    
    def send(
        self,
        request: httpx.Request,
        *,
        stream: bool = False,
        auth: Optional[httpx.Auth] = None,
        follow_redirects: Optional[bool] = None,
    ) -> httpx.Response:
        """Send request with automatic x402 payment handling."""
        send_kwargs: Dict[str, Any] = {"stream": stream}
        if auth is not None:
            send_kwargs["auth"] = auth
        if follow_redirects is not None:
            send_kwargs["follow_redirects"] = follow_redirects
        
        # Remove Authorization header - x402 proxy injects the real API key
        new_headers = httpx.Headers(request.headers)
        if "authorization" in new_headers:
            del new_headers["authorization"]
        
        request = self.build_request(
            method=request.method,
            url=request.url,
            headers=new_headers,
            content=request.content,
        )
        
        # Make initial request (non-streaming to check for 402)
        initial_kwargs = dict(send_kwargs)
        initial_kwargs["stream"] = False
        response = super().send(request, **initial_kwargs)
        
        # Handle 402 Payment Required
        if response.status_code == 402:
            try:
                payment_data = response.json()
            except Exception as e:
                raise ValueError(f"Failed to parse 402 payment requirements: {e}")
            
            if not payment_data.get("resource"):
                payment_data["resource"] = {
                    "uri": str(request.url),
                    "method": request.method,
                }
            
            signature = self._sign_payment(payment_data)
            
            new_headers = httpx.Headers(request.headers)
            new_headers["PAYMENT-SIGNATURE"] = signature
            
            new_request = self.build_request(
                method=request.method,
                url=request.url,
                headers=new_headers,
                content=request.content,
            )
            
            # For retry, don't stream so SDK can read response
            retry_kwargs = dict(send_kwargs)
            retry_kwargs["stream"] = False
            response = super().send(new_request, **retry_kwargs)
        
        return response
    
    def close(self) -> None:
        super().close()
        if self._backend_client:
            self._backend_client.close()


class WaterfallClient:
    """
    Waterfall client for x402 payments with OpenRouter.
    
    Provides direct access to OpenRouter's chat API with automatic
    payment signature handling via the x402 proxy.
    
    Example:
        client = WaterfallClient(x402_api_key="x402_...")
        client.configure_wallet(wallet_id="...")
        
        response = client.chat.send(
            model="openai/gpt-3.5-turbo",
            messages=[{"role": "user", "content": "Hello!"}]
        )
    """

    def __init__(
        self,
        x402_api_key: Optional[str] = None,
        wallet_id: Optional[str] = None,
        backend_url: Optional[str] = None,
        proxy_url: Optional[str] = None,
    ):
        """
        Initialize Waterfall client.

        Args:
            x402_api_key: x402 API key (x402_...) for authentication
            wallet_id: Optional wallet ID to use for payments
            backend_url: Backend URL for wallet operations (defaults to x402Instant)
            proxy_url: x402 proxy URL (defaults to X402_PROXY_URL)
        """
        self.x402_api_key = x402_api_key
        self.backend_url = backend_url or DEFAULT_BACKEND_URL
        self.proxy_url = (proxy_url or X402_PROXY_URL).rstrip("/")
        self.wallet_config = WalletConfig(wallet_id=wallet_id)
        
        self.wallet_manager = WalletManager(
            backend_url=self.backend_url,
            api_key=x402_api_key,
        )
        
        # Lazy-initialized OpenRouter client
        self._openrouter: Optional[OpenRouter] = None
        self._http_client: Optional[_X402HttpClient] = None

    def configure_wallet(
        self,
        wallet_id: Optional[str] = None,
        wallet_name: Optional[str] = None,
    ) -> "WaterfallClient":
        """
        Configure the wallet to use for signing.

        Args:
            wallet_id: Wallet ID to use
            wallet_name: Wallet name to look up

        If neither provided, fetches the default wallet.
        Returns self for method chaining.
        """
        if wallet_name:
            wallet_id = self.wallet_manager.get_wallet_by_name(wallet_name)
            if not wallet_id:
                raise ValueError(f"Wallet '{wallet_name}' not found")
        elif wallet_id is None:
            wallet_id = self.wallet_manager.get_default_wallet()

        self.wallet_config.wallet_id = wallet_id
        return self

    @property
    def chat(self):
        """
        Access OpenRouter chat API with automatic x402 payment handling.
        
        Returns the OpenRouter SDK's chat interface, which provides:
        - chat.send(model, messages, ...) - Send a chat completion request
        
        Example:
            response = client.chat.send(
                model="openai/gpt-3.5-turbo",
                messages=[{"role": "user", "content": "Hello!"}]
            )
        """
        if self._openrouter is None:
            self._http_client = _X402HttpClient(
                waterfall_client=self,
                timeout=60.0,
            )
            self._openrouter = OpenRouter(
                api_key="x402-proxy-managed",
                server_url=self.proxy_url,
                client=self._http_client,
            )
        return self._openrouter.chat

    def close(self):
        """Close the client and clean up resources."""
        if self._http_client:
            self._http_client.close()
            self._http_client = None
        self._openrouter = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
