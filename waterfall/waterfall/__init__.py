"""Waterfall - Python SDK for x402 payments with OpenRouter."""

from .client import WaterfallClient, DEFAULT_BACKEND_URL, X402_PROXY_URL
from .wallet import WalletConfig, WalletManager

__all__ = [
    "WaterfallClient",
    "WalletConfig",
    "WalletManager",
    "DEFAULT_BACKEND_URL",
    "X402_PROXY_URL",
]

__version__ = "0.1.0"
