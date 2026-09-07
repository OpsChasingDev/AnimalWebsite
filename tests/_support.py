"""Shared bootstrap for the app-level unit tests: import `app` against a
throwaway state dir and reset its per-process latches between tests."""
import os
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "journey-sample.json"
REAL_MANIFEST_PATH = REPO_ROOT / "static" / "images" / "alpine" / "manifest.json"

sys.path.insert(0, str(REPO_ROOT))


def import_app_with_temp_state(prefix: str):
    """app resolves STATE_DIR at import, so the override must land first."""
    os.environ["SITE_STATE_DIR"] = tempfile.mkdtemp(prefix=prefix)
    import app  # noqa: E402
    return app


def reset_app_state(app):
    """Clean slate per test: no warm model cache, and the "log this only once"
    latches cleared so each test can observe its own log line."""
    app._model_cache.update(at=0.0, model=None, retry_at=0.0)
    for k in app._fixture_logged:
        app._fixture_logged[k] = False
    return app.app.test_client()
