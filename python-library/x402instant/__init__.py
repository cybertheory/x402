"""x402instant - Python client library for x402Instant with automatic payment handling."""

from .client import X402InstantClient
from .pay.wallet_pay import (
    PaymentRequirement,
    PaymentRequired,
    WalletPayResponse,
    create_payment_signature,
)

__all__ = [
    "X402InstantClient",
    "PaymentRequirement",
    "PaymentRequired",
    "WalletPayResponse",
    "create_payment_signature",
]

__version__ = "0.1.0"


