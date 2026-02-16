"""Wallet pay client for calling the wallet-pay edge function."""

import json
from typing import Dict, List, Optional

import requests


class PaymentRequirement:
    """Payment requirement from x402 challenge."""

    def __init__(
        self,
        scheme: str,
        network: str,
        asset: str,
        pay_to: str,
        max_amount_required: str,
        resource: Optional[str] = None,
        description: Optional[str] = None,
        mime_type: Optional[str] = None,
        max_timeout_seconds: Optional[int] = None,
    ):
        self.scheme = scheme
        self.network = network
        self.asset = asset
        self.pay_to = pay_to
        self.max_amount_required = max_amount_required
        self.resource = resource
        self.description = description
        self.mime_type = mime_type
        self.max_timeout_seconds = max_timeout_seconds

    def to_dict(self) -> Dict:
        """Convert to dictionary."""
        result = {
            "scheme": self.scheme,
            "network": self.network,
            "asset": self.asset,
            "payTo": self.pay_to,
            "maxAmountRequired": self.max_amount_required,
        }
        if self.resource:
            result["resource"] = self.resource
        if self.description:
            result["description"] = self.description
        if self.mime_type:
            result["mimeType"] = self.mime_type
        if self.max_timeout_seconds:
            result["maxTimeoutSeconds"] = self.max_timeout_seconds
        return result


class PaymentRequired:
    """Payment required object from x402 challenge."""

    def __init__(
        self,
        x402_version: int,
        accepts: List[PaymentRequirement],
        error: Optional[str] = None,
        resource: Optional[Dict[str, str]] = None,
    ):
        self.x402_version = x402_version
        self.accepts = accepts
        self.error = error
        self.resource = resource

    def to_dict(self) -> Dict:
        """Convert to dictionary."""
        result = {
            "x402Version": self.x402_version,
            "accepts": [acc.to_dict() for acc in self.accepts],
        }
        if self.error:
            result["error"] = self.error
        if self.resource:
            result["resource"] = self.resource
        return result

    @classmethod
    def from_dict(cls, data: Dict) -> "PaymentRequired":
        """Create from dictionary."""
        accepts = [
            PaymentRequirement(
                scheme=acc.get("scheme", ""),
                network=acc.get("network", ""),
                asset=acc.get("asset", ""),
                pay_to=acc.get("payTo", ""),
                max_amount_required=acc.get("maxAmountRequired", ""),
                resource=acc.get("resource"),
                description=acc.get("description"),
                mime_type=acc.get("mimeType"),
                max_timeout_seconds=acc.get("maxTimeoutSeconds"),
            )
            for acc in data.get("accepts", [])
        ]
        return cls(
            x402_version=data.get("x402Version", 1),
            accepts=accepts,
            error=data.get("error"),
            resource=data.get("resource"),
        )


class WalletPayResponse:
    """Response from wallet-pay edge function."""

    def __init__(
        self,
        success: bool,
        signature: str,
        wallet_id: str,
        wallet_address: str,
    ):
        self.success = success
        self.signature = signature
        self.wallet_id = wallet_id
        self.wallet_address = wallet_address

    @classmethod
    def from_dict(cls, data: Dict) -> "WalletPayResponse":
        """Create from dictionary."""
        return cls(
            success=data.get("success", False),
            signature=data.get("signature", ""),
            wallet_id=data.get("wallet_id", ""),
            wallet_address=data.get("wallet_address", ""),
        )


def create_payment_signature(
    supabase_url: str,
    jwt: str,
    payment_required: PaymentRequired,
    wallet_id: Optional[str] = None,
) -> str:
    """
    Call the wallet-pay edge function to create an x402 payment signature.

    Args:
        supabase_url: Supabase project URL
        jwt: JWT token for authentication
        payment_required: PaymentRequired object
        wallet_id: Optional wallet ID (uses default if not provided)

    Returns:
        Payment signature string
    """
    # Create Supabase client with JWT in headers
    # We need an anon key, but we'll override auth with JWT
    # For supabase-py, we can pass headers in the options
    supabase: Client = create_client(
        supabase_url,
        "",  # Empty anon key - we'll use JWT in headers
    )
    
    # Set the authorization header for the function call
    # supabase-py doesn't directly support custom headers in invoke,
    # so we need to use the requests library directly or set it on the client
    # For now, we'll use a workaround by setting it in the client's headers
    import requests
    
    # Make the function call with JWT in headers
    function_url = f"{supabase_url}/functions/v1/wallet-pay"
    headers = {
        "Authorization": f"Bearer {jwt}",
        "Content-Type": "application/json",
    }
    
    payload = {
        "wallet_id": wallet_id,
        "paymentRequired": payment_required.to_dict(),
    }
    
    response = requests.post(function_url, json=payload, headers=headers)
    
    if response.status_code != 200:
        error_text = response.text
        try:
            error_data = response.json()
            error_msg = error_data.get("error", error_text)
        except:
            error_msg = error_text
        raise Exception(f"Failed to create payment signature: {error_msg}")

    # Parse response
    data = response.json()
    wallet_pay_response = WalletPayResponse.from_dict(data)
    if not wallet_pay_response.success or not wallet_pay_response.signature:
        raise Exception("Invalid response from wallet-pay function")

    return wallet_pay_response.signature

