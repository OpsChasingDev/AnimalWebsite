"""Unit tests for the JOURNEY_FIXTURE hook in app.get_model() (KTD7).

Plain unittest, not pytest: pytest is not a project dependency and adding it
is another unit's job. Run with:

    venv/bin/python -m unittest tests.test_fixture_mode -v

SITE_STATE_DIR is set *before* importing app, because app._resolve_state_dir()
runs once at import time and its result (app.STATE_DIR / app._model_snapshot)
is baked into module globals.
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_PATH = REPO_ROOT / "tests" / "fixtures" / "journey-sample.json"

_STATE_DIR = tempfile.mkdtemp(prefix="journey-fixture-test-state-")
os.environ["SITE_STATE_DIR"] = _STATE_DIR
sys.path.insert(0, str(REPO_ROOT))
import app  # noqa: E402  (must follow the SITE_STATE_DIR override above)


class FixtureModeTests(unittest.TestCase):
    def setUp(self):
        # Every test starts from a clean slate: no warm in-process cache, and
        # the "log this only once" flags reset so each test can observe its
        # own log line rather than being silenced by an earlier test's log.
        app._model_cache.update(at=0.0, model=None, retry_at=0.0)
        if hasattr(app, "_fixture_logged"):
            for k in app._fixture_logged:
                app._fixture_logged[k] = False
        self.client = app.app.test_client()

    def _clean_env(self, **overrides):
        """A dict.patch base with JOURNEY_FIXTURE/App Service markers cleared,
        then overridden — so leftovers from the real shell can't leak in."""
        base = {"JOURNEY_FIXTURE": "", "WEBSITE_INSTANCE_ID": "", "HOME": os.environ.get("HOME", "/tmp")}
        base.update(overrides)
        # patch.dict can't *unset* a var by giving it a falsy value, so drop
        # empty-string entries and delete them for real via `clear` per-key.
        return {k: v for k, v in base.items() if v != ""}

    def test_fixture_set_serves_fixture_without_storage(self):
        env = self._clean_env(JOURNEY_FIXTURE=str(FIXTURE_PATH))
        with mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop("WEBSITE_INSTANCE_ID", None)
            with mock.patch.object(app, "build_model") as m:
                resp = self.client.get("/")
                self.assertEqual(resp.status_code, 200)
                api_resp = self.client.get("/api/journey")
                self.assertEqual(api_resp.status_code, 200)
                m.assert_not_called()

        fixture_model = json.loads(FIXTURE_PATH.read_text())
        self.assertEqual(api_resp.get_json(), fixture_model)

    def test_unset_consults_normal_path(self):
        os.environ.pop("JOURNEY_FIXTURE", None)
        fake_model = {"pets": [], "events": [{"type": "today", "month": 0}],
                      "lore": [], "generated": "x", "trailhead_month": 0, "now_month": 0}
        with mock.patch.object(app, "build_model", return_value=fake_model) as m:
            result = app.get_model()
            m.assert_called_once()
            self.assertEqual(result, fake_model)

    def test_missing_fixture_file_falls_back(self):
        missing = str(Path(tempfile.mkdtemp()) / "does-not-exist.json")
        fake_model = {"pets": [], "events": [], "lore": [], "generated": "x",
                      "trailhead_month": 0, "now_month": 0}
        with mock.patch.dict(os.environ, {"JOURNEY_FIXTURE": missing}, clear=False):
            os.environ.pop("WEBSITE_INSTANCE_ID", None)
            with mock.patch.object(app, "build_model", return_value=fake_model) as m:
                with self.assertLogs(app.app.logger, level="WARNING"):
                    result = app.get_model()
                m.assert_called_once()
                self.assertEqual(result, fake_model)

    def test_app_service_markers_ignore_fixture_with_warning(self):
        env = {"JOURNEY_FIXTURE": str(FIXTURE_PATH),
               "WEBSITE_INSTANCE_ID": "some-instance-id",
               "HOME": "/home"}
        fake_model = {"pets": [], "events": [], "lore": [], "generated": "x",
                      "trailhead_month": 0, "now_month": 0}
        with mock.patch.dict(os.environ, env, clear=False):
            with mock.patch.object(app, "build_model", return_value=fake_model) as m:
                with self.assertLogs(app.app.logger, level="WARNING"):
                    result = app.get_model()
                m.assert_called_once()
                self.assertEqual(result, fake_model)

    def test_fixture_run_leaves_snapshot_untouched(self):
        snapshot_path = app._model_snapshot
        snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        original_bytes = json.dumps({"sentinel": "pre-existing last-good model"}).encode()
        snapshot_path.write_bytes(original_bytes)

        env = {"JOURNEY_FIXTURE": str(FIXTURE_PATH)}
        with mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop("WEBSITE_INSTANCE_ID", None)
            with mock.patch.object(app, "build_model") as m:
                app.get_model()
                m.assert_not_called()

        self.assertEqual(snapshot_path.read_bytes(), original_bytes)


if __name__ == "__main__":
    unittest.main()
