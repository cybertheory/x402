"""X402Instant Client - Automatically handles x402 payments in HTTP requests."""

import base64
import json
import time
from typing import Dict, Optional, Union

import requests
from supabase import create_client, Client

from .pay.wallet_pay import PaymentRequired, create_payment_signature


class X402InstantClient:
    """X402Instant Client - Automatically handles x402 payments in HTTP requests."""

    def __init__(
        self,
        api_key: str,
        supabase_url: str,
        wallet_id: Optional[str] = None,
    ):
        """
        Initialize X402Instant client.

        Args:
            api_key: API key (custom API key from x402Instant)
            supabase_url: Supabase project URL
            wallet_id: Optional default wallet ID
        """
        self.api_key = api_key
        self.supabase_url = supabase_url
        self.default_wallet_id = wallet_id

    def get_api_key(self) -> str:
        """
        Get the API key for authentication.
        The API key is used directly - no JWT conversion needed.

        Returns:
            API key string
        """
        return self.api_key

    def create_signature(
        self,
        payment_required: PaymentRequired,
        wallet_id: Optional[str] = None,
    ) -> str:
        """
        Create a payment signature using the wallet-pay edge function.

        Args:
            payment_required: PaymentRequired object
            wallet_id: Optional wallet ID (uses default if not provided)

        Returns:
            Payment signature string
        """
        api_key = self.get_api_key()
        target_wallet_id = wallet_id or self.default_wallet_id
        return create_payment_signature(
            self.supabase_url,
            api_key,
            payment_required,
            target_wallet_id,
        )

    def call(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[Dict[str, str]] = None,
        body: Optional[Union[str, Dict]] = None,
        wallet_id: Optional[str] = None,
    ) -> requests.Response:
        """
        Make an HTTP request and automatically handle x402 payment challenges.

        Args:
            url: The endpoint URL
            method: HTTP method (default: 'GET')
            headers: Request headers
            body: Request body (string or dict)
            wallet_id: Wallet ID to use for payment (overrides default)

        Returns:
            Response object
        """
        request_headers = headers.copy() if headers else {}
        request_body = body

        # Convert body to string if it's a dict
        if isinstance(request_body, dict):
            request_body = json.dumps(request_body)
            if "Content-Type" not in request_headers:
                request_headers["Content-Type"] = "application/json"

        # Make initial request
        response = requests.request(
            method=method,
            url=url,
            headers=request_headers,
            data=request_body,
        )

        # Check for 402 Payment Required
        if response.status_code == 402:
            # Parse PaymentRequired from response
            payment_required_header = (
                response.headers.get("PAYMENT-REQUIRED")
                or response.headers.get("X-PAYMENT-REQUIRED")
            )

            payment_required: PaymentRequired

            if payment_required_header:
                try:
                    # Try to parse as base64 JSON first
                    decoded = base64.b64decode(payment_required_header).decode("utf-8")
                    payment_required = PaymentRequired.from_dict(json.loads(decoded))
                except Exception:
                    # If not base64, try direct JSON
                    try:
                        payment_required = PaymentRequired.from_dict(
                            json.loads(payment_required_header)
                        )
                    except Exception:
                        # If header parsing fails, try response body
                        try:
                            payment_required = PaymentRequired.from_dict(response.json())
                        except Exception:
                            raise Exception(
                                "Failed to parse PaymentRequired from 402 response"
                            )
            else:
                # Try to parse from response body
                try:
                    payment_required = PaymentRequired.from_dict(response.json())
                except Exception:
                    raise Exception(
                        "Failed to parse PaymentRequired from 402 response"
                    )

            # Ensure resource is set
            if not payment_required.resource:
                payment_required.resource = {
                    "uri": url,
                    "method": method,
                }

            # Create payment signature
            payment_signature = self.create_signature(
                payment_required,
                wallet_id,
            )

            # Retry request with payment signature
            payment_headers = request_headers.copy()
            payment_headers["PAYMENT-SIGNATURE"] = payment_signature

            response = requests.request(
                method=method,
                url=url,
                headers=payment_headers,
                data=request_body,
            )

        return response

    @property
    def pay(self):
        """Pay package - provides payment-related methods."""
        return PayPackage(self)


class PayPackage:
    """Pay package for X402InstantClient."""

    def __init__(self, client: X402InstantClient):
        self._client = client

    def create_signature(
        self,
        payment_required: PaymentRequired,
        wallet_id: Optional[str] = None,
    ) -> str:
        """
        Create a payment signature for a PaymentRequired object.

        Args:
            payment_required: The payment requirement from a 402 response
            wallet_id: Optional wallet ID (uses default if not provided)

        Returns:
            Payment signature string
        """
        return self._client.create_signature(payment_required, wallet_id)


