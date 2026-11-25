"""Exercise the Meta webhook boundary without a database or external requests."""
import hashlib
import hmac
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class MetaWebhookTest(unittest.TestCase):
    def test_signature_before_processing(self):
        raw = b'{ "object": "whatsapp_business_account" }'
        secret = "local-test-secret"
        signature = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
        client = TestClient(server.app)
        path = "/api/wa/webhook"
        with patch.object(server, "process_webhook", new_callable=AsyncMock) as process:
            with patch.object(server, "META_APP_SECRET", ""):
                self.assertEqual(client.post(path, content=raw).status_code, 503)
            with patch.object(server, "META_APP_SECRET", secret):
                for headers, content in [
                    ({}, raw), ({"X-Hub-Signature-256": "invalid"}, raw),
                    ({"X-Hub-Signature-256": signature}, raw + b" "),
                ]:
                    self.assertEqual(client.post(path, content=content, headers=headers).status_code, 403)
                process.assert_not_awaited()
                response = client.post(path, content=raw, headers={"X-Hub-Signature-256": signature})
                self.assertEqual(response.status_code, 200)
                process.assert_awaited_once_with({"object": "whatsapp_business_account"})


if __name__ == "__main__":
    unittest.main()
