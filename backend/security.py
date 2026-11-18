"""Security helpers for Charm.Studio: password hashing, token signing, secret encryption.

Kept free of app imports so it can be read and tested on its own.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any, Dict, Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Passwords: scrypt (stdlib), stored as "scrypt$N$r$p$salt$hash"
# ---------------------------------------------------------------------------
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P, _SCRYPT_LEN = 2**14, 8, 1, 32

# A short list of passwords that are always rejected (checked case-insensitively).
COMMON_PASSWORDS = {
    "12345678", "123456789", "1234567890", "87654321", "11111111", "00000000", "password", "password1",
    "password123", "qwerty123", "qwertyuiop", "iloveyou", "admin123", "letmein1", "welcome1", "abc12345",
    "charmstudio", "charm.studio", "asdfghjk", "1q2w3e4r", "zaq12wsx", "india123", "11223344",
}


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=_SCRYPT_LEN)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${b64e(salt)}${b64e(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, dk = stored.split("$")
        if algo != "scrypt":
            return False
        expected = b64d(dk)
        calc = hashlib.scrypt(
            password.encode(), salt=b64d(salt), n=int(n), r=int(r), p=int(p), dklen=len(expected)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(calc, expected)


def password_problem(password: str, email: str = "") -> Optional[str]:
    """Return a human-readable reason the password is not acceptable, or None."""
    if len(password) < 8:
        return "Use at least 8 characters."
    if len(password) > 128:
        return "Use at most 128 characters."
    lowered = password.lower()
    if lowered in COMMON_PASSWORDS or len(set(password)) < 3:
        return "That password is too easy to guess. Try a few random words with a number."
    if email and lowered == email.strip().lower():
        return "Don't use your email address as your password."
    return None


# ---------------------------------------------------------------------------
# Signed tokens: base64url(json claims) + "." + base64url(HMAC-SHA256)
# ---------------------------------------------------------------------------
def sign_token(key: bytes, claims: Dict[str, Any]) -> str:
    payload = b64e(json.dumps(claims, separators=(",", ":")).encode())
    sig = b64e(hmac.new(key, payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{sig}"


def read_token(key: bytes, token: str, now: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """Return the claims if the signature is valid and the token hasn't expired."""
    try:
        payload, sig = token.split(".", 1)
        expected = b64e(hmac.new(key, payload.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        claims = json.loads(b64d(payload))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(claims, dict) or claims.get("exp", 0) < (time.time() if now is None else now):
        return None
    return claims


def new_reset_token() -> str:
    return secrets.token_urlsafe(32)


# ---------------------------------------------------------------------------
# Secret encryption (AES-256-GCM) for values stored in the database,
# e.g. WhatsApp access tokens. The key is derived from AUTH_SECRET, so
# changing AUTH_SECRET makes stored secrets unreadable (they must be re-entered).
# ---------------------------------------------------------------------------
class SecretBox:
    PREFIX = "v1:"

    def __init__(self, master_secret: str, purpose: str = "charm-studio:secrets"):
        key = hmac.new(master_secret.encode(), purpose.encode(), hashlib.sha256).digest()
        self._aes = AESGCM(key)

    def encrypt(self, plaintext: str) -> str:
        nonce = os.urandom(12)
        return self.PREFIX + b64e(nonce + self._aes.encrypt(nonce, plaintext.encode(), None))

    def decrypt(self, token: str) -> str:
        """Raise ValueError if the value can't be decrypted (wrong key or tampered)."""
        if not token.startswith(self.PREFIX):
            raise ValueError("unknown format")
        raw = b64d(token[len(self.PREFIX):])
        try:
            return self._aes.decrypt(raw[:12], raw[12:], None).decode()
        except (InvalidTag, ValueError) as e:
            raise ValueError("cannot decrypt") from e
