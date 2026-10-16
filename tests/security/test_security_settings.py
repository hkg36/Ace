from crew.security.settings import (
    configure_security,
    sandbox_supported,
    strict_security_enabled,
    websocket_transport_block_reason,
)


def test_windows_sandbox_is_temporarily_disabled(monkeypatch):
    with monkeypatch.context() as patch:
        patch.setattr("crew.security.settings.sys.platform", "win32")
        assert sandbox_supported() is False


def test_macos_and_linux_sandbox_remain_supported(monkeypatch):
    for platform in ("darwin", "linux"):
        with monkeypatch.context() as patch:
            patch.setattr("crew.security.settings.sys.platform", platform)
            assert sandbox_supported() is True


def test_security_defaults_disabled_and_allows_plaintext_websocket():
    configure_security(enabled=False)

    assert strict_security_enabled() is False
    assert websocket_transport_block_reason("ws://channel.example/socket") is None
    assert websocket_transport_block_reason("wss://channel.example/socket") is None


def test_configured_security_blocks_plaintext_websocket():
    configure_security(enabled=True)

    assert strict_security_enabled() is True
    assert websocket_transport_block_reason("ws://channel.example/socket")


def test_disabled_security_allows_plaintext_websocket():
    configure_security(enabled=False)

    assert strict_security_enabled() is False
    assert websocket_transport_block_reason("ws://legacy.example/socket") is None
