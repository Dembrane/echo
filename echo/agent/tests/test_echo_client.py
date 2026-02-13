from echo_client import EchoClient


def test_echo_client_sets_authorization_header():
    client = EchoClient(bearer_token="abc123")
    try:
        assert client._client.headers.get("Authorization") == "Bearer abc123"
    finally:
        # Async close is tested in integration; this test only checks header wiring.
        pass


def test_echo_client_without_token_has_no_authorization_header():
    client = EchoClient(bearer_token=None)
    try:
        assert client._client.headers.get("Authorization") is None
    finally:
        pass
