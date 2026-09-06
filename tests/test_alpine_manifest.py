"""Unit tests for the alpine art manifest loader (KTD9 / U4).

Plain unittest, not pytest, matching tests/test_fixture_mode.py. Run with:

    venv/bin/python -m unittest tests.test_alpine_manifest -v

SITE_STATE_DIR is set *before* importing app for the same reason
test_fixture_mode.py sets it: app._resolve_state_dir() runs once at import
time, and importing app is also what runs _load_alpine_manifest() at import
to build app.ALPINE_MANIFEST.
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
REAL_MANIFEST_PATH = REPO_ROOT / "static" / "images" / "alpine" / "manifest.json"

_STATE_DIR = tempfile.mkdtemp(prefix="alpine-manifest-test-state-")
os.environ["SITE_STATE_DIR"] = _STATE_DIR
sys.path.insert(0, str(REPO_ROOT))
import app  # noqa: E402  (must follow the SITE_STATE_DIR override above)


class LoadAlpineManifestTests(unittest.TestCase):
    def test_valid_file_returns_parsed_dict(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "manifest.json"
            data = {"version": 1, "assets": [{"file": "x.webp", "hash": "abc"}]}
            p.write_text(json.dumps(data))
            self.assertEqual(app._load_alpine_manifest(p), data)

    def test_missing_path_returns_empty_manifest_and_logs_error(self):
        missing = Path(tempfile.mkdtemp()) / "does-not-exist.json"
        with self.assertLogs(app.app.logger, level="ERROR"):
            result = app._load_alpine_manifest(missing)
        self.assertEqual(result, {"version": 1, "assets": []})

    def test_corrupt_json_returns_empty_manifest_and_logs_error(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "manifest.json"
            p.write_text("{not json")
            with self.assertLogs(app.app.logger, level="ERROR"):
                result = app._load_alpine_manifest(p)
            self.assertEqual(result, {"version": 1, "assets": []})

    def test_real_manifest_loads_at_import(self):
        # The module-level ALPINE_MANIFEST is built at import time from the
        # real on-disk manifest; sanity-check it actually has the real assets
        # rather than the empty fallback (i.e. the real file parses cleanly).
        self.assertGreater(len(app.ALPINE_MANIFEST.get("assets", [])), 0)


class JourneyRouteAlpineTests(unittest.TestCase):
    def setUp(self):
        app._model_cache.update(at=0.0, model=None, retry_at=0.0)
        if hasattr(app, "_fixture_logged"):
            for k in app._fixture_logged:
                app._fixture_logged[k] = False
        self.client = app.app.test_client()

    def test_journey_page_includes_window_alpine_with_real_assets(self):
        env = {"JOURNEY_FIXTURE": str(FIXTURE_PATH)}
        with mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop("WEBSITE_INSTANCE_ID", None)
            resp = self.client.get("/")
        self.assertEqual(resp.status_code, 200)
        body = resp.get_data(as_text=True)
        self.assertIn("window.ALPINE = ", body)
        # The real manifest's asset list should be serialized into the page,
        # not the empty fallback — spot-check one known file name.
        self.assertIn("ground-overlay-a.webp", body)


if __name__ == "__main__":
    unittest.main()
