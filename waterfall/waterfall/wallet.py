"""Wallet configuration and management for Waterfall client."""

from typing import Optional, Dict, Any, List
from dataclasses import dataclass
import httpx


@dataclass
class WalletConfig:
    """Configuration for wallet selection and usage."""

    wallet_id: Optional[str] = None
    """Optional wallet ID to use. If None, uses default wallet."""

    def to_dict(self) -> Dict[str, Any]:
        """Convert wallet config to dictionary for API requests."""
        result: Dict[str, Any] = {}
        if self.wallet_id:
            result["wallet_id"] = self.wallet_id
        return result


class WalletManager:
    """Manages wallet operations and communication with Supabase backend."""

    def __init__(
        self,
        backend_url: Optional[str] = None,
        api_key: Optional[str] = None,
    ):
        """
        Initialize wallet manager.

        Args:
            backend_url: URL of the Supabase functions backend
            api_key: x402Instant API key (x402_...) for authentication
        """
        self.backend_url = backend_url
        self.api_key = api_key
        self._http_client: Optional[httpx.Client] = None

        # Derive REST API URL from functions URL
        # e.g., https://xxx.supabase.co/functions/v1 -> https://xxx.supabase.co/rest/v1
        if backend_url:
            # Extract base URL (before /functions/v1)
            base_url = backend_url.replace("/functions/v1", "")
            self.rest_url = f"{base_url}/rest/v1"
        else:
            self.rest_url = None

    def _get_http_client(self) -> httpx.Client:
        """Get or create HTTP client with lazy initialization."""
        if self._http_client is None:
            self._http_client = httpx.Client(timeout=30.0)
        return self._http_client

    def _get_auth_headers(self) -> Dict[str, str]:
        """Get authorization headers for Supabase requests."""
        headers: Dict[str, str] = {
            "Content-Type": "application/json",
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
            # Supabase REST API also needs apikey header
            headers["apikey"] = self.api_key
        return headers

    def list_wallets(self, chain: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        List all wallets for the authenticated tenant.

        Args:
            chain: Optional chain filter (e.g., "base-sepolia", "base")

        Returns:
            List of wallet dictionaries
        """
        if not self.rest_url:
            raise ValueError("Backend URL not configured")

        params: Dict[str, str] = {
            "select": "id,name,address,chain,is_default,created_at",
            "order": "is_default.desc,created_at.desc",
        }
        if chain:
            params["chain"] = f"eq.{chain}"

        response = self._get_http_client().get(
            f"{self.rest_url}/wallets",
            params=params,
            headers=self._get_auth_headers(),
        )
        response.raise_for_status()
        return response.json()

    def get_default_wallet(self, chain: Optional[str] = None) -> Optional[str]:
        """
        Get the default wallet ID.

        Args:
            chain: Optional chain filter to get default for specific chain

        Returns:
            Default wallet ID or None if not available
        """
        if not self.rest_url:
            return None

        params: Dict[str, str] = {
            "select": "id",
            "is_default": "eq.true",
            "limit": "1",
        }
        if chain:
            params["chain"] = f"eq.{chain}"

        try:
            response = self._get_http_client().get(
                f"{self.rest_url}/wallets",
                params=params,
                headers=self._get_auth_headers(),
            )
            response.raise_for_status()
            wallets = response.json()
            return wallets[0]["id"] if wallets else None
        except Exception:
            return None

    def get_wallet_by_name(self, name: str) -> Optional[str]:
        """
        Get wallet ID by name.

        Args:
            name: Name of the wallet

        Returns:
            Wallet ID or None if not found
        """
        if not self.rest_url:
            return None

        params: Dict[str, str] = {
            "select": "id",
            "name": f"eq.{name}",
            "limit": "1",
        }

        try:
            response = self._get_http_client().get(
                f"{self.rest_url}/wallets",
                params=params,
                headers=self._get_auth_headers(),
            )
            response.raise_for_status()
            wallets = response.json()
            return wallets[0]["id"] if wallets else None
        except Exception:
            return None

    def get_wallet(self, wallet_id: str) -> Optional[Dict[str, Any]]:
        """
        Get wallet details by ID.

        Args:
            wallet_id: Wallet UUID

        Returns:
            Wallet dictionary or None if not found
        """
        if not self.rest_url:
            return None

        params: Dict[str, str] = {
            "select": "id,name,address,chain,is_default,created_at",
            "id": f"eq.{wallet_id}",
            "limit": "1",
        }

        try:
            response = self._get_http_client().get(
                f"{self.rest_url}/wallets",
                params=params,
                headers=self._get_auth_headers(),
            )
            response.raise_for_status()
            wallets = response.json()
            return wallets[0] if wallets else None
        except Exception:
            return None

    def sign_data(self, data: bytes, wallet_id: Optional[str] = None) -> str:
        """
        Sign data using the specified wallet.

        Args:
            data: Data to sign
            wallet_id: Optional wallet ID. If None, uses default wallet.

        Returns:
            Signature string

        Note:
            This is a placeholder. For x402 payments, use the wallet-pay
            endpoint via the provider's _create_payment_signature method.
        """
        raise NotImplementedError(
            "Direct signing not supported. Use wallet-pay endpoint for x402 payments."
        )

    def close(self):
        """Close the HTTP client."""
        if self._http_client:
            self._http_client.close()
            self._http_client = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
