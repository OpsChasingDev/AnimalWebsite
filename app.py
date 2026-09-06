from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from email.utils import parsedate_to_datetime
from functools import wraps
from pathlib import Path

from flask import (Flask, abort, jsonify, make_response, redirect,
                   render_template, request, send_file)
from PIL import Image, ImageOps
from werkzeug.exceptions import HTTPException

app = Flask(__name__)

BLOB_ACCOUNT_HOST = "animalwebsitestg.blob.core.windows.net"
DEFAULT_BLOB_BASE_URL = f"https://{BLOB_ACCOUNT_HOST}/pets"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
MODEL_CACHE_TTL = 60  # seconds
MODEL_RETRY_TTL = 5  # after a failed build, serve stale for this long before retrying
THUMB_DIR = Path(os.environ.get("THUMB_CACHE_DIR", "/tmp/petthumbs"))
THUMB_WIDTHS = {320, 480, 800, 1200}

# Storage reads are authenticated with the app's managed identity (the container
# is private): x-ms-version must be >= 2017-11-09 for Entra bearer auth.
STORAGE_RESOURCE = "https://storage.azure.com/"
STORAGE_API_VERSION = "2021-08-06"
TOKEN_MARGIN = 300  # refresh this many seconds before expiry
TOKEN_FALLBACK_TTL = 3300  # used when the response carries no usable expiry
# After a token failure, back off *briefly* rather than for a long window: a
# transient blip on a cold instance (no stale model yet) must be able to heal on
# the next request instead of pinning the whole site down. Short enough to
# self-heal, long enough that a request storm cannot hot-loop the IMDS endpoint.
TOKEN_RETRY_INTERVAL = 3

# Pre-seal safety net. While the container is still publicly readable, a token
# failure should degrade to the read path the site used before this change
# rather than to an empty site. Set ALLOW_ANON_BLOB_READ=0 in the same change
# that seals the container (spec 7) — after that an anonymous read only 403s.
ALLOW_ANON_BLOB_READ = os.environ.get("ALLOW_ANON_BLOB_READ", "1") != "0"

# Gallery files named like 2022-06_lakeday.jpg (or 2022-06-14_lakeday.jpg) are
# placed on the timeline at that date; PXL_/IMG_/bare datestamps are read too;
# anything else falls back to blob Last-Modified (upload time).
DATE_PREFIX_RE = re.compile(r"^(\d{4})-(\d{2})(?:-(\d{2}))?[_-]")
FILENAME_DATE_RES = (
    DATE_PREFIX_RE,
    re.compile(r"^PXL_(\d{4})(\d{2})(\d{2})_", re.I),        # Pixel
    re.compile(r"^IMG_(\d{4})(\d{2})(\d{2})[_-]", re.I),     # generic / WhatsApp
    re.compile(r"^(\d{4})(\d{2})(\d{2})[_-]"),               # bare datestamp
)
SAFE_IMG_PATH_RE = re.compile(
    r"[a-z0-9_-]+/(?:gallery/[^/\\]+|headshot\.(?:jpg|jpeg|png|webp))", re.I
)

# Accent fallback rotation for pets whose meta.json omits "color".
FALLBACK_COLORS = ["#8A4E76", "#C9718A", "#3F7D77", "#C98A3D", "#5B7FA6", "#A6702E"]

def _resolve_state_dir() -> Path:
    """Where the things that must outlive a container recycle go.

    THUMB_DIR is a *cache* — /tmp by default, per-instance, wiped on restart and
    on scale-out. The last-good model snapshot and the CSRF key are not caches:
    without them a cold instance has no fallback at all (a token blip becomes a
    full-site 500) and every restart invalidates outstanding upload pages. On
    App Service Linux /home is persistent app storage, so prefer it and fall
    back to the thumbnail dir only if it is not writable.
    """
    candidates = []
    override = os.environ.get("SITE_STATE_DIR")
    if override:
        candidates.append(Path(override))
    if os.environ.get("WEBSITE_INSTANCE_ID") and os.environ.get("HOME") == "/home":
        candidates.append(Path("/home/data/petsite"))
    candidates.append(THUMB_DIR)
    for path in candidates:
        try:
            path.mkdir(parents=True, exist_ok=True)
            probe = path / f".probe.{os.getpid()}"
            probe.write_bytes(b"")
            probe.unlink()
            return path
        except OSError:
            continue
    return THUMB_DIR


STATE_DIR = _resolve_state_dir()

_model_cache: dict = {"at": 0.0, "model": None, "retry_at": 0.0}
_model_snapshot = STATE_DIR / "model.json"  # last-good model, survives a restart
# _model_cache is per-process, so an upload handled by one gunicorn worker cannot
# invalidate the others. This sentinel lives in STATE_DIR, which every worker in
# the container shares; get_model() treats a newer stamp as "your cache is
# stale". It is shared per *instance*, not across instances: on the default
# /tmp a second App Service instance would not see the stamp and could serve a
# just-uploaded photo up to MODEL_CACHE_TTL late. Harmless at one instance
# (the current plan: B2, capacity 1); revisit before scaling out.
_model_stamp = STATE_DIR / "model.stamp"
_token_cache: dict = {"tok": None, "exp": 0.0, "retry_at": 0.0, "bounce_at": 0.0}
# Accumulate-only: /img must keep serving paths a *previous* good build
# published, so a storage blip cannot blank the allowlist and 404 every image.
_img_paths_cache: dict = {"model": None, "paths": frozenset()}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A blob GET has no legitimate redirect, and urllib copies Authorization
    across hosts when it follows one. Refuse to follow at all."""

    def redirect_request(self, *a, **kw):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def blob_base_url() -> str:
    url = os.environ.get("BLOB_BASE_URL", DEFAULT_BLOB_BASE_URL).rstrip("/")
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.netloc != BLOB_ACCOUNT_HOST:
        raise RuntimeError(f"BLOB_BASE_URL must be https://{BLOB_ACCOUNT_HOST}/..., got {url!r}")
    return url


try:
    blob_base_url()  # surface a misconfigured setting in the log at startup
except RuntimeError:
    # Deliberately not fatal: raising here would fail the import and take down
    # every route, static files included. blob_base_url() runs on every call, so
    # a bad value still refuses to aim a storage token elsewhere — it just
    # degrades to the stale model / "trail is loading" page instead of a 502.
    app.logger.exception("BLOB_BASE_URL is misconfigured; storage reads will fail")


def _token_expiry(data: dict, now: float) -> float:
    """expires_on is epoch seconds on App Service, a local-time string from older
    az CLIs, and occasionally absent. Never let parsing it kill the token."""
    raw = data.get("expires_on", data.get("expiresOn"))
    exp = 0.0
    if raw is not None:
        try:
            exp = float(raw)
        except (TypeError, ValueError):
            try:
                exp = datetime.fromisoformat(str(raw).strip()).timestamp()
            except ValueError:
                exp = 0.0
    if exp <= now:  # absent, unparsable, or relative — treat as seconds remaining
        try:
            exp = now + float(data["expires_in"])
        except (KeyError, TypeError, ValueError):
            exp = now + TOKEN_FALLBACK_TTL
    return min(exp, now + 3600.0)


def storage_token() -> str:
    now = time.time()
    if _token_cache["tok"] and now < _token_cache["exp"] - TOKEN_MARGIN:
        return _token_cache["tok"]
    if now < _token_cache["retry_at"]:
        # One attempt per TOKEN_RETRY_INTERVAL, not a long negative cache: this
        # is hot-loop protection, never a guaranteed outage window.
        raise RuntimeError("storage token unavailable (retrying shortly)")
    _token_cache["retry_at"] = now + TOKEN_RETRY_INTERVAL  # claim this attempt
    try:
        endpoint, header = os.environ.get("IDENTITY_ENDPOINT"), os.environ.get("IDENTITY_HEADER")
        if endpoint and header:  # App Service managed identity
            url = (f"{endpoint}?resource={urllib.parse.quote(STORAGE_RESOURCE)}"
                   "&api-version=2019-08-01")
            req = urllib.request.Request(url, headers={"X-IDENTITY-HEADER": header})
            with _opener.open(req, timeout=10) as resp:
                data = json.loads(resp.read())
        else:  # local dev — the developer's own az login (spec 5)
            try:
                out = subprocess.run(
                    ["az", "account", "get-access-token", "--resource", STORAGE_RESOURCE],
                    capture_output=True, text=True, check=True)
            except FileNotFoundError:
                raise RuntimeError(
                    "no IDENTITY_ENDPOINT (managed identity) and no az CLI on PATH — "
                    "run `az login` for local dev") from None
            except subprocess.CalledProcessError as e:
                raise RuntimeError(
                    f"az account get-access-token failed — run `az login`: "
                    f"{(e.stderr or '').strip()[:200]}") from None
            data = json.loads(out.stdout)
        tok = data.get("access_token") or data["accessToken"]  # MSI vs az CLI casing
    except Exception:
        app.logger.exception("could not acquire a storage token")
        raise
    _token_cache.update(tok=tok, exp=_token_expiry(data, now), retry_at=0.0)
    return tok


def _fetch(url: str, timeout: int = 10, _retry: bool = True, _anon: bool = False) -> bytes:
    on_blob = urllib.parse.urlsplit(url).netloc == BLOB_ACCOUNT_HOST
    req = urllib.request.Request(url)
    if on_blob and not _anon:
        try:
            tok = storage_token()
        except Exception:
            if not ALLOW_ANON_BLOB_READ:
                raise
            app.logger.error("no storage token; falling back to an anonymous read of %s", url)
            return _fetch(url, timeout, _retry=False, _anon=True)
        # unredirected: never replayed onto a redirect target
        req.add_unredirected_header("Authorization", f"Bearer {tok}")
        req.add_unredirected_header("x-ms-version", STORAGE_API_VERSION)
    try:
        with _opener.open(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        if on_blob and not _anon and e.code in (401, 403):
            now = time.time()
            if _retry and now >= _token_cache["bounce_at"]:
                # Stale token: drop it and try once with a fresh one. Rate
                # limited, and retry_at is left alone, so a *persistent* 403 —
                # RBAC still propagating after the seal, say — cannot make every
                # anonymous page view pull new tokens from the identity endpoint.
                _token_cache.update(tok=None, exp=0.0,
                                    bounce_at=now + TOKEN_RETRY_INTERVAL)
                return _fetch(url, timeout, _retry=False)
            if ALLOW_ANON_BLOB_READ:
                app.logger.error("authenticated read of %s returned %s; "
                                 "falling back to an anonymous read", url, e.code)
                return _fetch(url, timeout, _retry=False, _anon=True)
        raise


def _fetch_blob(path: str, timeout: int = 10) -> bytes | None:
    url = f"{blob_base_url()}/{urllib.parse.quote(path)}"
    try:
        return _fetch(url, timeout)
    except urllib.error.HTTPError as e:
        # A missing blob is ordinary (optional meta.json, captions.txt, lore).
        # Anything else is the site losing its storage and must be visible.
        log = app.logger.info if e.code == 404 else app.logger.error
        log("blob GET %s -> HTTP %s", path, e.code)
        return None
    except Exception:
        app.logger.exception("blob GET %s failed", path)
        return None


def list_container() -> list[tuple[str, datetime | None]]:
    """List every blob in the container (handles paging). [(name, last_modified)]"""
    base = blob_base_url()
    marker = ""
    out: list[tuple[str, datetime | None]] = []
    while True:
        url = f"{base}?restype=container&comp=list"
        if marker:
            url += f"&marker={urllib.parse.quote(marker)}"
        root = ET.fromstring(_fetch(url))
        for blob in root.iter("Blob"):
            name = blob.findtext("Name") or ""
            lm_text = blob.findtext("Properties/Last-Modified") or ""
            try:
                lm = parsedate_to_datetime(lm_text)
            except (TypeError, ValueError):
                lm = None
            out.append((name, lm))
        marker = root.findtext("NextMarker") or ""
        if not marker:
            break
    return out


def _month_key(ym: str | None) -> int | None:
    """'2022-06' -> 2022*12+5, for easy month arithmetic."""
    if not ym:
        return None
    try:
        y, m = int(ym[:4]), int(ym[5:7])
        return y * 12 + (m - 1)
    except (ValueError, IndexError):
        return None


def _season(month_idx: int) -> str:
    m = month_idx % 12 + 1
    if m in (12, 1, 2):
        return "winter"
    if m in (3, 4, 5):
        return "spring"
    if m in (6, 7, 8):
        return "summer"
    return "autumn"


def _photo_date(filename: str, last_modified: datetime | None) -> str:
    # An explicit YYYY-MM_ prefix is a deliberate human statement about the date
    # (the endnote on the trail documents it), so it is honoured verbatim, with
    # no year bounds — a 1974 scan is exactly the case it exists for. The
    # *inferred* camera patterns get sanity bounds, because there a stray match
    # on an unrelated filename would silently move a photo on the timeline.
    limit = datetime.utcnow().year + 1
    for rx in FILENAME_DATE_RES:
        m = rx.match(filename)
        if not m:
            continue
        if rx is DATE_PREFIX_RE:
            return f"{m.group(1)}-{m.group(2)}"
        if 1990 <= int(m.group(1)) <= limit and 1 <= int(m.group(2)) <= 12:
            return f"{m.group(1)}-{m.group(2)}"
    if last_modified:
        return last_modified.strftime("%Y-%m")
    return datetime.utcnow().strftime("%Y-%m")


def _parse_captions(text: str) -> dict[str, str]:
    """Lines like 'filename.jpg: a caption' -> {filename: caption}."""
    out = {}
    for line in text.splitlines():
        if ":" in line:
            fname, _, cap = line.partition(":")
            if fname.strip() and cap.strip():
                out[fname.strip()] = cap.strip()
    return out


def _img_url(path: str, width: int) -> str:
    """The only way a blob reaches a browser: the resizing proxy, never a blob URL.

    Site-relative by design. /api/journey used to publish absolute blob URLs;
    once the container is sealed those 403, so every published URL is now a path
    on this site (spec 6.3) — an external consumer must join it to the site's
    own origin.
    """
    return f"/img?path={urllib.parse.quote(path)}&w={width}"


def build_model() -> dict:
    blobs = list_container()

    raw_pets: dict[str, dict] = {}
    for name, lm in blobs:
        slug, _, rest = name.partition("/")
        if not slug or not rest:
            continue
        pet = raw_pets.setdefault(slug, {"gallery": [], "has_meta": False,
                                         "has_captions": False, "headshot": None})
        if rest == "meta.json":
            pet["has_meta"] = True
        elif rest == "captions.txt":
            pet["has_captions"] = True
        elif rest.startswith("headshot."):
            pet["headshot"] = name
        elif rest.startswith("gallery/"):
            fname = rest[len("gallery/"):]
            if os.path.splitext(fname)[1].lower() in IMAGE_EXTS:
                pet["gallery"].append((fname, name, lm))

    pets: list[dict] = []
    for i, (slug, raw) in enumerate(sorted(raw_pets.items())):
        if not raw["headshot"]:
            continue  # a pet folder needs at least a headshot to appear
        meta = {}
        if raw["has_meta"]:
            data = _fetch_blob(f"{slug}/meta.json")
            if data:
                try:
                    meta = json.loads(data)
                except ValueError:
                    meta = {}
        captions: dict[str, str] = {}
        if raw["has_captions"]:
            data = _fetch_blob(f"{slug}/captions.txt")
            if data:
                captions = _parse_captions(data.decode("utf-8", "replace"))

        photos = []
        for fname, blobname, lm in raw["gallery"]:
            taken = _photo_date(fname, lm)
            photos.append({
                "file": fname,
                "blob": blobname,
                # originals are private by design; the API publishes derivatives only
                "url": _img_url(blobname, 1200),
                "thumb": _img_url(blobname, 480),
                "large": _img_url(blobname, 1200),
                "taken": taken,
                "dog": slug,
                "caption": captions.get(fname, ""),
            })
        photos.sort(key=lambda p: p["taken"])

        joined = meta.get("joined")
        if not joined and photos:
            joined = photos[0]["taken"]  # zero-config fallback

        pets.append({
            "slug": slug,
            "name": meta.get("name") or slug.replace("-", " ").title(),
            "color": meta.get("color") or FALLBACK_COLORS[i % len(FALLBACK_COLORS)],
            "born": meta.get("born"),
            "joined": joined,
            "passed": meta.get("passed"),
            "bio": meta.get("bio") or "",
            "headshot": raw["headshot"],
            "headshot_url": _img_url(raw["headshot"], 1200),
            "headshot_thumb": _img_url(raw["headshot"], 480),
            "headshot_large": _img_url(raw["headshot"], 800),
            "photos": photos,
        })

    pets.sort(key=lambda p: (_month_key(p["joined"]) is None, _month_key(p["joined"]) or 0))

    # ---- journey events ----
    events: list[dict] = []
    founders = [p for p in pets if _month_key(p["joined"]) is not None][:2]
    later = [p for p in pets if p["slug"] not in {f["slug"] for f in founders}]

    if founders:
        union_month = max(_month_key(f["joined"]) for f in founders)
        events.append({"type": "union", "month": union_month,
                       "pets": [f["slug"] for f in founders]})
    else:
        union_month = _month_key(datetime.utcnow().strftime("%Y-%m"))

    for p in later:
        mk = _month_key(p["joined"])
        if mk is not None:
            events.append({"type": "arrival", "month": mk, "pet": p["slug"]})

    for p in pets:
        mk = _month_key(p["passed"])
        if mk is not None:
            events.append({"type": "passing", "month": mk, "pet": p["slug"]})

    # season camps: all photos across dogs grouped by (year, season)
    camps: dict[tuple[int, str], dict] = {}
    for p in pets:
        for ph in p["photos"]:
            mk = _month_key(ph["taken"])
            if mk is None:
                continue
            mk = max(mk, union_month)  # nothing renders before the trailhead
            key = (mk // 12, _season(mk))
            camp = camps.setdefault(key, {"type": "camp", "months": [], "photos": []})
            camp["months"].append(mk)
            camp["photos"].append(ph)
    for (year, season), camp in camps.items():
        camp["month"] = min(camp["months"])
        camp["season"] = season
        camp["year"] = year
        camp["label"] = f"{season.title()} {year}"
        del camp["months"]
        events.append(camp)

    now_month = _month_key(datetime.utcnow().strftime("%Y-%m"))
    events.sort(key=lambda e: (e["month"], 0 if e["type"] == "union" else 1))
    events.append({"type": "today", "month": now_month})

    # family lore easter eggs: optional _trail/lore.json in the container
    lore = []
    lore_raw = _fetch_blob("_trail/lore.json")
    if lore_raw:
        try:
            parsed = json.loads(lore_raw)
            if isinstance(parsed, list):
                for item in parsed:
                    mk = _month_key(item.get("date"))
                    if mk is not None and item.get("note"):
                        lore.append({
                            "month": mk,
                            "item": item.get("item", "bone"),
                            "dog": item.get("dog"),
                            "note": item["note"],
                        })
        except ValueError:
            pass

    return {
        "generated": datetime.utcnow().isoformat() + "Z",
        "trailhead_month": union_month,
        "now_month": now_month,
        "pets": pets,
        "events": events,
        "lore": lore,
    }


def _snapshot_save(model: dict) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = _model_snapshot.with_suffix(".tmp")
        tmp.write_text(json.dumps(model))
        tmp.replace(_model_snapshot)
    except Exception:
        pass  # a snapshot is a nicety; never fail a page over it


def _snapshot_load() -> dict | None:
    try:
        return json.loads(_model_snapshot.read_text())
    except Exception:
        return None


def _model_stamp_mtime() -> float:
    try:
        return _model_stamp.stat().st_mtime
    except OSError:
        return 0.0


def invalidate_model() -> None:
    """Called after a successful upload. Clears this process's cache and stamps
    the shared sentinel so sibling workers drop theirs on their next request."""
    _model_cache.update(at=0.0, retry_at=0.0)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        _model_stamp.touch()
    except Exception:
        pass  # worst case the photo shows up a minute later


# "log this only once" latches for the fixture hook below, so a long-running
# process doesn't spam the same line on every request.
_fixture_logged: dict = {"active": False, "ignored": False}


def get_model() -> dict:
    # JOURNEY_FIXTURE lets the journey run from a saved model JSON with no
    # storage credentials, so U3's browser smoke script (and a laptop) can
    # render the page without az login. It must never leak onto the live
    # site, so the same App Service check _resolve_state_dir() uses (an
    # instance ID plus /home as HOME) wins over the env var, loudly: a
    # leftover setting on the real site must not start serving fake data.
    fixture_path = os.environ.get("JOURNEY_FIXTURE")
    if fixture_path:
        if os.environ.get("WEBSITE_INSTANCE_ID") and os.environ.get("HOME") == "/home":
            if not _fixture_logged["ignored"]:
                _fixture_logged["ignored"] = True
                app.logger.warning(
                    "JOURNEY_FIXTURE=%s ignored: running on App Service", fixture_path)
        else:
            try:
                fixture_model = json.loads(Path(fixture_path).read_text())
            except OSError as e:
                app.logger.warning(
                    "JOURNEY_FIXTURE=%s unreadable (%s); falling back to the normal model",
                    fixture_path, e)
            except ValueError as e:
                app.logger.warning(
                    "JOURNEY_FIXTURE=%s is not valid JSON (%s); falling back to the normal model",
                    fixture_path, e)
            else:
                if not _fixture_logged["active"]:
                    _fixture_logged["active"] = True
                    app.logger.info(
                        "JOURNEY_FIXTURE=%s: serving the fixture model, storage untouched",
                        fixture_path)
                return fixture_model  # never touches _model_cache or the on-disk snapshot

    now = time.time()
    cached = _model_cache["model"]
    if (cached is not None
            and now - _model_cache["at"] < MODEL_CACHE_TTL
            and _model_cache["at"] >= _model_stamp_mtime()):
        return cached
    if cached is not None and now < _model_cache["retry_at"]:
        return cached  # a build failed a moment ago; don't stampede storage
    try:
        model = build_model()
    except Exception:
        # stale beats broken — and the on-disk snapshot makes that survive a
        # cold start, where the in-process cache is empty (alwaysOn is off).
        # Loud, because a page that renders from a stale snapshot while storage
        # is unreachable looks healthy from the outside (spec 7's curl of "/").
        app.logger.exception("model build failed; falling back to the last good model")
        stale = cached or _snapshot_load()
        if stale is not None:
            # Keep "at" stale so the model is refreshed as soon as storage is
            # back, but hold off long enough that a page's worth of images does
            # not each re-attempt a full failing build.
            _model_cache.update(model=stale, retry_at=now + MODEL_RETRY_TTL)
            return stale
        raise
    _model_cache.update(at=now, model=model, retry_at=0.0)
    _snapshot_save(model)
    return model


def allowed_img_paths() -> frozenset[str]:
    """Blobs the model publishes. Shape is not membership: /img is the only
    public read path once the container is sealed, so it serves these only.

    Accumulate-only. A path that a good build once published stays servable even
    if the *next* build fails, so a storage blip cannot turn every image on the
    site into a 404. Removing a photo from the container therefore keeps its
    path allowed until the process restarts — harmless, since the blob itself is
    then gone and the fetch 404s anyway.
    """
    try:
        model = get_model()
    except Exception:
        return _img_paths_cache["paths"]  # whatever the last good build published
    if _img_paths_cache["model"] is not model:
        paths = set(_img_paths_cache["paths"])
        for p in model.get("pets", []):
            if p.get("headshot"):
                paths.add(p["headshot"])
            paths.update(ph["blob"] for ph in p.get("photos", []) if ph.get("blob"))
        _img_paths_cache.update(model=model, paths=frozenset(paths))
    return _img_paths_cache["paths"]


def _unavailable(message: str):
    """The model could not be built and there is no stale copy to fall back on
    (a cold instance whose token path is broken). Say so plainly instead of
    letting the exception become a bare 500."""
    app.logger.error("serving the unavailable page: %s", message)
    return render_template("unavailable.html", message=message), 503


@app.route("/")
def journey():
    try:
        model = get_model()
    except Exception:
        return _unavailable("The trail is still loading.")
    return render_template("journey.html", journey=model)


@app.route("/api/journey")
def api_journey():
    try:
        return jsonify(get_model())
    except Exception:
        app.logger.exception("/api/journey has no model to serve")
        return jsonify({"ok": False, "error": "unavailable",
                        "message": "The journey is still loading."}), 503


@app.route("/pets/<slug>")
def pet_detail(slug):
    try:
        model = get_model()
    except Exception:
        return _unavailable("The trail is still loading.")
    pet = next((p for p in model["pets"] if p["slug"] == slug), None)
    if pet is None:
        abort(404)
    return render_template("detail.html", pet=pet)


@app.route("/img")
def img_proxy():
    """Resize-and-cache proxy so the trail loads small images."""
    path = request.args.get("path", "")
    try:
        width = int(request.args.get("w", "480"))
    except ValueError:
        abort(400)
    if width not in THUMB_WIDTHS or not SAFE_IMG_PATH_RE.fullmatch(path):
        abort(400)

    key = hashlib.sha1(f"{path}|{width}".encode()).hexdigest()
    cached = THUMB_DIR / f"{key}.jpg"
    # A derivative on disk is itself proof this path passed the allowlist once,
    # so serve it without touching the model: image serving must not depend on
    # a container listing that may be mid-rebuild (or failing).
    if cached.exists():
        return send_file(cached, mimetype="image/jpeg", max_age=86400)
    if path not in allowed_img_paths():
        abort(404)

    try:
        data = _fetch(f"{blob_base_url()}/{urllib.parse.quote(path)}", timeout=20)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            abort(404)  # the blob is genuinely gone
        app.logger.error("blob GET %s -> HTTP %s", path, e.code)
        abort(502)  # reachable-but-refused is not "not found"
    except Exception:
        app.logger.exception("blob GET %s failed", path)
        abort(502)

    tmp = cached.with_name(f"{key}.{os.getpid()}.tmp")
    try:
        THUMB_DIR.mkdir(parents=True, exist_ok=True)
        im = Image.open(io.BytesIO(data))
        im = ImageOps.exif_transpose(im)
        im.thumbnail((width, width * 2))
        # via a temp file: a half-written derivative must never become the
        # cached one, now that an existing file is served without further checks
        im.convert("RGB").save(tmp, "JPEG", quality=82)
        tmp.replace(cached)
    except Exception:
        tmp.unlink(missing_ok=True)
        app.logger.exception("could not render %s at w=%s", path, width)
        abort(415)
    return send_file(cached, mimetype="image/jpeg", max_age=86400)


# ===========================================================================
# PHASE 2 — /upload
# ===========================================================================

UPLOAD_MAX_BYTES = 25 * 1024 * 1024
# Werkzeug enforces this while streaming, so a chunked body (no Content-Length)
# cannot slip past a hand-rolled content_length check.
# Room for the multipart envelope (boundaries, filename, slug, taken_override)
# so a photo just under the limit hits our own message, not Werkzeug's generic
# 413. The real user-facing limit is the len(body) check in upload_post().
app.config["MAX_CONTENT_LENGTH"] = UPLOAD_MAX_BYTES + 1024 * 1024
INSPECT_MAX_BYTES = 1024 * 1024  # the preflight only ever carries a file's head

UPLOAD_MIN_YEAR = 1990
HEIC_EXTS = {".heic", ".heif"}
CONTENT_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                 ".png": "image/png", ".webp": "image/webp"}
PET_SLUG_RE = re.compile(r"[a-z0-9_-]{1,64}")
# The assembled path is re-validated as a whole immediately before the PUT, so
# no component (including the date, which is EXIF-derived and attacker-shaped)
# can introduce a separator and escape the gallery.
BLOB_PATH_RE = re.compile(
    r"[a-z0-9_-]{1,64}/gallery/\d{4}-\d{2}_[a-z0-9-]{1,48}(?:-\d{1,2})?\.(?:jpg|jpeg|png|webp)")

# Every hostname the site answers on. The two custom domains, plus each app's
# azurewebsites.net default host — which is regionalized and unguessable
# (animalwebsite-anbacpdahzg8djgn.eastus2-01...), so the running app's own
# WEBSITE_HOSTNAME is added below rather than hand-maintained here. Re-derive
# with: az webapp list --query "[].defaultHostName".
UPLOAD_ORIGINS = {
    "https://pets.stapleton-family.net",
    "https://staging-pets.stapleton-family.net",
    "https://animalwebsite-anbacpdahzg8djgn.eastus2-01.azurewebsites.net",
    "https://animalwebsite-staging.azurewebsites.net",
}
_platform_host = os.environ.get("WEBSITE_HOSTNAME", "").strip().rstrip("/")
if _platform_host:  # platform-injected, not client-supplied
    UPLOAD_ORIGINS.add(f"https://{_platform_host}")

# --- LOCAL-DEV-ONLY route registration ------------------------------------
# Be precise about what this does, because the opposite belief is dangerous:
# _principal() reads the X-MS-CLIENT-PRINCIPAL* headers straight off the request
# in EVERY environment, and the app has no way to check their provenance. The
# only thing that makes them trustworthy is the Easy Auth module sitting in the
# request path and stripping client-supplied copies — see EASY_AUTH_RUNNING
# below, which is the single load-bearing check.
#
# UPLOAD_DEV_AUTH=1 does exactly two things: it registers the /upload routes off
# App Service, and it adds this request's own scheme+host to the allowed
# origins. Everything else about the guard still runs (aad check, claims decode,
# allowlist, CSRF), so the guard itself is what gets exercised.
#
# It is impossible to turn on in App Service: it additionally requires that NONE
# of the platform's own environment variables are present, and App Service sets
# all of these on every instance. An app setting called UPLOAD_DEV_AUTH would be
# inert there. Both values are frozen at import, so nothing can flip them later.
_APP_SERVICE_MARKERS = (
    "WEBSITE_SITE_NAME", "WEBSITE_INSTANCE_ID", "WEBSITE_HOSTNAME",
    "WEBSITE_RESOURCE_GROUP", "WEBSITE_OWNER_NAME", "WEBSITE_AUTH_ENABLED",
    "WEBSITE_SKU", "WEBSITE_COMPUTE_MODE", "IDENTITY_ENDPOINT", "IDENTITY_HEADER",
    "APPSETTING_WEBSITE_SITE_NAME", "WEBSITES_PORT", "APPSVC_RUN_ZIP",
    "WEBSITE_AUTH_V2_CONFIG_JSON", "WEBSITE_PLATFORM_VERSION",
)
ON_APP_SERVICE = any(os.environ.get(v) for v in _APP_SERVICE_MARKERS)
UPLOAD_DEV_AUTH = os.environ.get("UPLOAD_DEV_AUTH") == "1" and not ON_APP_SERVICE

def _easy_auth_running() -> bool:
    """Is the Easy Auth module actually in the request path?

    This is the one load-bearing check in the whole feature: without the module,
    X-MS-CLIENT-PRINCIPAL* are attacker-supplied strings and the guard is
    theatre, so /upload is not registered at all and is simply a 404.

    Both signals are platform-injected and read-only, and every present signal
    must AGREE — presence is not state. WEBSITE_AUTH_V2_CONFIG_JSON mirrors the
    authV2 configuration in ARM and survives turning auth off (the portal toggle
    and `az webapp auth update --enabled false` set platform.enabled=false and
    leave the config in place), so it is parsed, never merely detected.
    """
    raw = os.environ.get("WEBSITE_AUTH_V2_CONFIG_JSON")
    flag = os.environ.get("WEBSITE_AUTH_ENABLED")
    if raw:
        try:
            if json.loads(raw).get("platform", {}).get("enabled") is not True:
                return False
        except (ValueError, AttributeError):
            return False  # unreadable config is not evidence of a running module
        # authV2 is configured and enabled; the V1 flag must not contradict it
        # (it may be absent on an authV2 site, which is not a contradiction).
        return flag is None or flag.strip().lower() == "true"
    return (flag or "").strip().lower() == "true"  # V1 (classic) configuration


EASY_AUTH_RUNNING = _easy_auth_running()
UPLOAD_ENABLED = EASY_AUTH_RUNNING or UPLOAD_DEV_AUTH


def _is_upload_path(path: str) -> bool:
    return path == "/upload" or path.startswith("/upload/")


# --- error envelope -------------------------------------------------------

_ERROR_SLUGS = {400: "bad_request", 401: "not_signed_in", 403: "forbidden",
                404: "not_found", 405: "bad_method", 411: "length_required",
                413: "too_large", 415: "unsupported_type", 422: "date_required",
                500: "server_error", 502: "storage_error", 503: "unavailable"}


def upload_error(status: int, slug: str, message: str, file: str | None = None):
    """The single failure shape for every /upload* route."""
    payload = {"ok": False, "error": slug, "message": message}
    if file is not None:
        payload["file"] = file
    return jsonify(payload), status


@app.errorhandler(HTTPException)
def _upload_error_envelope(e):
    """abort() renders HTML by default; on upload routes the client is a fetch()
    and needs the JSON envelope for every failure, not just the ones we raise.

    Only where the feature exists: on a deployment with no upload routes, /upload
    must 404 exactly like any other unknown path rather than announcing itself
    as specially handled."""
    if UPLOAD_ENABLED and _is_upload_path(request.path):
        return upload_error(e.code or 500, _ERROR_SLUGS.get(e.code, "error"),
                            e.description or "Upload failed.")
    return e


# --- who is calling -------------------------------------------------------

# Claim types Entra emits for the immutable object id and for a display name.
_OID_CLAIMS = ("http://schemas.microsoft.com/identity/claims/objectidentifier", "oid")
# Easy Auth maps `sub` to the WS-Fed nameidentifier URI during claims mapping.
_SUB_CLAIMS = ("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
               "sub")
_NAME_CLAIMS = ("preferred_username",
                "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn", "upn",
                "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
                "email", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
                "name")


def _principal() -> "tuple[str, str] | None":
    """(object_id, display_name) for an aad-authenticated caller, else None.

    Verified rather than trusted-by-presence: the provider must be aad (both in
    the header and in the claims blob), the base64 claims blob must decode, and
    it must carry an object id that agrees with the id header. These headers are
    only meaningful because Easy Auth injects them and strips client copies —
    see EASY_AUTH_RUNNING.
    """
    idp = request.headers.get("X-MS-CLIENT-PRINCIPAL-IDP", "")
    if idp.lower() != "aad":
        # Only noise-free because an anonymous caller sends no headers at all.
        if idp:
            app.logger.warning("upload auth: provider is %r, expected 'aad'", idp)
        return None
    raw = request.headers.get("X-MS-CLIENT-PRINCIPAL", "")
    if not raw:
        app.logger.warning("upload auth: provider header present but no claims blob")
        return None
    try:
        blob = json.loads(base64.b64decode(raw + "=" * (-len(raw) % 4)))
        claim_list = blob["claims"]
    except Exception:
        app.logger.warning("upload auth: claims blob did not decode")
        return None
    auth_typ = str(blob.get("auth_typ", ""))
    if auth_typ.lower() != "aad":
        app.logger.warning("upload auth: auth_typ is %r, expected 'aad'", auth_typ)
        return None
    claims: dict = {}
    for c in claim_list or []:
        try:
            typ, val = c.get("typ"), c.get("val")
        except AttributeError:
            continue
        if typ and val is not None and typ not in claims:
            claims[typ] = str(val)
    oid = next((claims[t] for t in _OID_CLAIMS if claims.get(t)), "")
    if not oid:
        app.logger.warning("upload auth: no object-id claim in principal blob")
        return None
    # Cross-check the id header against the claims so a forged claims blob alone
    # is not enough. The header carries whatever the provider considers the
    # caller's id -- for Entra that is `sub`, a per-application pairwise value
    # that is deliberately NOT equal to `oid` -- so accept a match on either.
    # Requiring oid specifically rejects every real sign-in and loops the login.
    header_id = request.headers.get("X-MS-CLIENT-PRINCIPAL-ID", "").lower()
    sub = next((claims[t] for t in _SUB_CLAIMS if claims.get(t)), "")
    if not header_id or header_id not in {oid.lower(), sub.lower()}:
        app.logger.warning("upload auth: id header does not match oid or sub claim")
        return None
    name = next((claims[t] for t in _NAME_CLAIMS if claims.get(t)),
                request.headers.get("X-MS-CLIENT-PRINCIPAL-NAME", "")) or oid
    return oid, name


def upload_allowlist() -> "set[str]":
    """The optional second lock (spec 9.2), comma-separated in
    UPLOAD_ALLOWED_PRINCIPALS.

    Unset means "any principal Entra let through", which is not fail-open: the
    enterprise app has assignment required with exactly two users assigned, so
    Entra is the source of truth and nobody else can obtain the headers at all.
    Making it mandatory would mean an unset app setting silently disables
    uploading for everyone.

    Entries may be object ids (preferred — stable) or sign-in names (convenient,
    but derived from a configurable nameClaimType); either matches, so a
    name-shaped value cannot lock a legitimate uploader out.
    """
    raw = os.environ.get("UPLOAD_ALLOWED_PRINCIPALS", "")
    return {s.strip().lower() for s in raw.split(",") if s.strip()}


def upload_origins() -> "set[str]":
    out = set(UPLOAD_ORIGINS)
    extra = os.environ.get("UPLOAD_EXTRA_ORIGINS", "")
    out.update(s.strip().rstrip("/") for s in extra.split(",") if s.strip())
    if UPLOAD_DEV_AUTH:  # LOCAL DEV ONLY — never true on App Service
        out.add(f"{request.scheme}://{request.host}")
    return out


# --- CSRF -----------------------------------------------------------------
# A custom request header forces a CORS preflight that a cross-site attacker
# cannot satisfy; the HMAC ties the token to the signed-in principal.

_csrf_key: dict = {"key": None}


def _csrf_key_from_file(path: Path) -> bytes:
    """One key per container, created exactly once.

    O_CREAT|O_EXCL means a worker either creates the file or loses the race and
    adopts the winner's key. A last-writer-wins rename would leave two workers
    holding different keys for the life of the process, so a token minted by
    GET /upload on one worker would be rejected by POST /upload on another and
    reloading would not help.
    """
    for _ in range(10):
        try:
            key = path.read_bytes()
        except OSError:
            key = b""
        if len(key) == 32:
            return key
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            time.sleep(0.05)  # the winner is mid-write; read it on the next pass
            continue
        except OSError:
            break
        try:
            key = secrets.token_bytes(32)
            with os.fdopen(fd, "wb") as fh:
                fh.write(key)
            return key
        except OSError:
            break
    app.logger.error("could not establish a shared CSRF key at %s; using a "
                     "per-process key (set UPLOAD_CSRF_SECRET to fix)", path)
    return secrets.token_bytes(32)


def csrf_secret() -> bytes:
    if _csrf_key["key"]:
        return _csrf_key["key"]
    env = os.environ.get("UPLOAD_CSRF_SECRET")
    if env:
        key = hashlib.sha256(env.encode()).digest()
    else:
        # STATE_DIR is shared by every worker in the container. Setting
        # UPLOAD_CSRF_SECRET is still better: it also survives a restart and is
        # shared across instances, so outstanding upload pages keep working.
        key = _csrf_key_from_file(STATE_DIR / "csrf.key")
    _csrf_key["key"] = key
    return key


CSRF_TTL = 12 * 3600


def csrf_mint(oid: str) -> str:
    issued = int(time.time())
    mac = hmac.new(csrf_secret(), f"{oid}|{issued}".encode(), hashlib.sha256).hexdigest()
    return f"{issued}.{mac}"


def csrf_ok(token: str, oid: str) -> bool:
    try:
        issued_s, mac = (token or "").split(".", 1)
        issued = int(issued_s)
    except ValueError:
        return False
    if not 0 <= time.time() - issued <= CSRF_TTL:
        return False
    want = hmac.new(csrf_secret(), f"{oid}|{issued}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, mac)


# --- the guard ------------------------------------------------------------

def upload_guard():
    """None when the request may proceed, otherwise the response to send.

    Used by @require_upload_auth *and* by a before_request backstop, so a route
    that forgets the decorator (or stacks it above @app.route, where Flask would
    register the undecorated view) still fails closed.
    """
    if not UPLOAD_ENABLED:
        return None  # nothing is registered here; let Flask 404
    who = _principal()
    if who is None:
        # Easy Auth already authenticated this caller but we could not build a
        # principal from what it injected. Redirecting to login would land right
        # back here and loop forever, so fail loudly instead — _principal() has
        # logged which check rejected it.
        if request.headers.get("X-MS-CLIENT-PRINCIPAL") or \
                request.headers.get("X-MS-CLIENT-PRINCIPAL-ID"):
            app.logger.error("upload auth: signed in but principal unusable — "
                             "refusing to redirect (would loop)")
            if request.method in ("GET", "HEAD"):
                return render_template("unavailable.html", message=(
                    "You are signed in, but this site could not read your "
                    "identity from the sign-in. Nothing was uploaded. This is a "
                    "configuration problem, not something you did wrong.")), 403
            return upload_error(403, "principal_unusable",
                                "Signed in, but your identity could not be read.")
        if request.method in ("GET", "HEAD"):
            target = urllib.parse.quote(request.full_path.rstrip("?"), safe="/")
            return redirect(f"/.auth/login/aad?post_login_redirect_uri={target}")
        # Never redirect a write: fetch() follows it transparently and the caller
        # reads 200 + a login page as success while nothing was written.
        return upload_error(401, "not_signed_in",
                            "Your sign-in has expired — reload the page to sign in again.")
    oid, name = who
    allow = upload_allowlist()
    # Empty = Entra assignment is the only gate (spec 9.2). When set, an object
    # id *or* a sign-in name may match, so either style of value works.
    if allow and not ({oid.lower(), name.lower()} & allow):
        app.logger.warning("upload refused for %s (%s): not in UPLOAD_ALLOWED_PRINCIPALS",
                           name, oid)
        return upload_error(403, "not_allowed", "This account is not allowed to upload.")
    if request.method not in ("GET", "HEAD"):
        # A multipart POST is a CORS "simple request" and App Service issues its
        # session cookie with SameSite=None, so all three checks are load-bearing.
        if request.headers.get("Sec-Fetch-Site") != "same-origin":
            return upload_error(403, "bad_origin", "Refused: cross-site request.")
        if request.headers.get("Origin", "") not in upload_origins():
            return upload_error(403, "bad_origin", "Refused: cross-site request.")
        if not csrf_ok(request.headers.get("X-CSRF-Token", ""), oid):
            return upload_error(403, "bad_csrf",
                                "This page is out of date — reload it and try again.")
    request.environ["upload.principal"] = (oid, name)
    return None


def require_upload_auth(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if request.environ.get("upload.principal") is not None:
            return fn(*a, **kw)  # the backstop already ran the guard this request
        blocked = upload_guard()
        if blocked is not None:
            return blocked
        return fn(*a, **kw)
    return wrapper


@app.before_request
def _upload_backstop():
    """Default-deny for the whole /upload namespace, decorator or no decorator."""
    if _is_upload_path(request.path):
        return upload_guard()
    return None


def _principal_now() -> "tuple[str, str]":
    return request.environ.get("upload.principal", ("", ""))


# --- dates (spec 11.1) ----------------------------------------------------

class DateUndetermined(Exception):
    """No date could be derived. Never fall back to today."""


class BadOverride(Exception):
    """The client sent a taken_override that is malformed or out of range."""


_TAKEN_RE = re.compile(r"\d{4}-(?:0[1-9]|1[0-2])")
_EXIF_DT_RE = re.compile(r"\s*(\d{4}):(\d{2}):(\d{2})[ T]")


def current_month() -> str:
    return datetime.utcnow().strftime("%Y-%m")


def max_taken_month() -> str:
    """One month past the current UTC month. The server clock is UTC while a
    phone shooting just after local midnight on the 1st in a UTC-ahead zone
    carries next month — rejecting that would silently discard a perfectly good
    EXIF date and demand the photo be dated by hand."""
    y, m = int(current_month()[:4]), int(current_month()[5:7])
    return f"{y + 1}-01" if m == 12 else f"{y}-{m + 1:02d}"


def check_taken(taken) -> str:
    """Every branch of resolve_taken() ends here. EXIF strings are
    attacker-supplied bytes that Pillow returns verbatim, so validating only the
    client override would let a crafted DateTimeOriginal shape the blob path."""
    if not isinstance(taken, str) or not _TAKEN_RE.fullmatch(taken):
        raise DateUndetermined
    if int(taken[:4]) < UPLOAD_MIN_YEAR or taken > max_taken_month():
        raise DateUndetermined
    return taken


def _exif_taken(data: bytes) -> "str | None":
    try:
        exif = Image.open(io.BytesIO(data)).getexif()
        sub = exif.get_ifd(0x8769)  # ExifIFD
    except Exception:
        return None
    for tag in (36867, 36868):  # DateTimeOriginal, DateTimeDigitized
        value = sub.get(tag)
        if isinstance(value, bytes):
            value = value.decode("ascii", "ignore")
        if not isinstance(value, str):
            continue
        m = _EXIF_DT_RE.match(value)
        if not m:
            continue
        try:
            return check_taken(f"{m.group(1)}-{m.group(2)}")
        except DateUndetermined:
            continue
    return None


def _filename_taken(filename: str) -> "str | None":
    base = os.path.basename(filename or "")
    for rx in FILENAME_DATE_RES:
        m = rx.match(base)
        if not m:
            continue
        try:
            return check_taken(f"{m.group(1)}-{m.group(2)}")
        except DateUndetermined:
            continue
    return None


def resolve_taken(filename: str, data: bytes,
                  override: "str | None" = None) -> "tuple[str, str]":
    """('YYYY-MM', source). Raises rather than guessing."""
    if override:
        try:
            return check_taken(override.strip()), "override"
        except DateUndetermined:
            raise BadOverride
    taken = _exif_taken(data)
    if taken:
        return taken, "exif"
    taken = _filename_taken(filename)
    if taken:
        return taken, "filename"
    raise DateUndetermined


# --- filename construction (spec 13.1) ------------------------------------

_DATESTAMP_STRIP_RE = re.compile(
    r"^(?:\d{4}-\d{2}(?:-\d{2})?[_-]|PXL_\d{8}_|IMG_\d{8}[_-]|\d{8}[_-])+", re.I)


def strip_leading_datestamp(base: str) -> str:
    return _DATESTAMP_STRIP_RE.sub("", base)


def build_safe_name(original_name: str, taken: str, n: int = 1) -> str:
    """`name_slug`, deliberately not `slug` — the pet slug is a different value
    and the two must not be able to shadow each other."""
    base, ext = os.path.splitext(os.path.basename(original_name or ""))
    ext = ext.lower()
    base = strip_leading_datestamp(base)
    name_slug = re.sub(r"[^a-z0-9]+", "-", base.lower())[:48].strip("-") or "photo"
    suffix = "" if n <= 1 else f"-{n}"          # before the extension, not after
    return f"{taken}_{name_slug}{suffix}{ext}"


# --- EXIF GPS stripping (spec 14) -----------------------------------------
# Rewrites the EXIF block only. The compressed image data is spliced through
# byte-for-byte, so nothing is re-encoded and nothing is degraded.

def _jpeg_app1_span(data: bytes) -> "tuple[int, int] | None":
    if not data.startswith(b"\xff\xd8"):
        return None
    i, n = 2, len(data)
    while i + 4 <= n:
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:
            i += 2
            continue
        if marker in (0xD9, 0xDA):  # EOI / start of scan — no more metadata
            return None
        length = int.from_bytes(data[i + 2:i + 4], "big")
        if length < 2 or i + 2 + length > n:
            return None
        if marker == 0xE1 and data[i + 4:i + 10] == b"Exif\x00\x00":
            return i, i + 2 + length
        i += 2 + length
    return None


def _exif_forget_gps(exif) -> None:
    exif.pop(0x8825, None)
    for attr in ("_ifds", "_hidden_data"):  # Pillow re-emits these on tobytes()
        cache = getattr(exif, attr, None)
        if isinstance(cache, dict):
            cache.pop(0x8825, None)


def _minimal_exif(src) -> bytes:
    """Fallback: keep only what the site needs (orientation, capture date)."""
    out = Image.Exif()
    for tag in (0x0112, 0x011A, 0x011B, 0x0128):  # orientation + resolution
        if tag in src:
            out[tag] = src[tag]
    try:
        sub = dict(src.get_ifd(0x8769))
    except Exception:
        sub = {}
    keep = {t: sub[t] for t in (36867, 36868) if t in sub}
    if keep:
        out[0x8769] = keep
    return out.tobytes()


def _jpeg_strip_gps(data: bytes) -> bytes:
    span = _jpeg_app1_span(data)
    if span is None:
        return data
    start, end = span
    exif = Image.Exif()
    exif.load(data[start + 4:end])
    exif.get_ifd(0x8769)  # materialise nested IFDs before mutating
    had_gps = bool(exif.get_ifd(0x8825)) or 0x8825 in exif
    if not had_gps:
        return data
    _exif_forget_gps(exif)
    payload = exif.tobytes()  # already prefixed with b"Exif\0\0"
    check = Image.Exif()
    check.load(payload)
    if 0x8825 in check or check.get_ifd(0x8825) or len(payload) + 2 > 0xFFFF:
        payload = _minimal_exif(exif)
    if len(payload) + 2 > 0xFFFF:
        return data[:start] + data[end:]  # last resort: drop the segment
    header = b"\xff\xe1" + (len(payload) + 2).to_bytes(2, "big")
    return data[:start] + header + payload + data[end:]


def _png_drop_exif(data: bytes) -> bytes:
    sig = b"\x89PNG\r\n\x1a\n"
    if not data.startswith(sig):
        return data
    out, i, changed = bytearray(sig), len(sig), False
    while i + 8 <= len(data):
        length = int.from_bytes(data[i:i + 4], "big")
        ctype = data[i + 4:i + 8]
        nxt = i + 12 + length
        if nxt > len(data):
            return data
        if ctype == b"eXIf":
            changed = True
        else:
            out += data[i:nxt]
        if ctype == b"IEND":
            break
        i = nxt
    return bytes(out) if changed else data


def _webp_drop_exif(data: bytes) -> bytes:
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return data
    body, out, i, changed = data[12:], bytearray(), 0, False
    while i + 8 <= len(body):
        ctype = body[i:i + 4]
        length = int.from_bytes(body[i + 4:i + 8], "little")
        step = 8 + length + (length & 1)
        chunk = body[i:i + step]
        if len(chunk) < 8 + length:
            return data
        if ctype == b"EXIF":
            changed = True
        else:
            if ctype == b"VP8X" and length >= 1:
                chunk = bytearray(chunk)
                chunk[8] &= ~0x08  # clear the "has EXIF" flag
                chunk = bytes(chunk)
            out += chunk
        i += step
    if not changed:
        return data
    return b"RIFF" + (len(out) + 4).to_bytes(4, "little") + b"WEBP" + bytes(out)


def strip_gps(data: bytes, ext: str) -> bytes:
    try:
        if ext in (".jpg", ".jpeg"):
            return _jpeg_strip_gps(data)
        if ext == ".png":
            return _png_drop_exif(data)
        if ext == ".webp":
            return _webp_drop_exif(data)
    except Exception:
        app.logger.exception("GPS strip failed for a %s upload", ext)
        if ext in (".jpg", ".jpeg"):
            span = _jpeg_app1_span(data)
            if span:  # privacy wins over keeping the orientation tag
                return data[:span[0]] + data[span[1]:]
    return data


# --- the bytes really are a photo (spec 13.6) -----------------------------
# Pillow's format name -> the extensions it may be stored under. MPO is the
# multi-picture JPEG that dual-camera phones emit; it is a JPEG for our purposes.
_FORMAT_EXTS = {"JPEG": {".jpg", ".jpeg"}, "MPO": {".jpg", ".jpeg"},
                "PNG": {".png"}, "WEBP": {".webp"}}


class NotAnImage(Exception):
    """The body is not a decodable image of the type its extension claims."""


def verify_image(body: bytes, ext: str) -> None:
    """The extension decides the Content-Type and the gallery it lands in, so it
    has to be true. Without this, any bytes with a photo extension are stored,
    join the model, and become a tile the trail can never render and the phone
    UI offers no way to remove — a mis-tapped or truncated pick does that by
    accident, not by malice."""
    try:
        im = Image.open(io.BytesIO(body))
        fmt = (im.format or "").upper()
        im.verify()  # structural check; consumes the stream, so open() again to use it
    except Exception:
        raise NotAnImage("That file isn't a photo we can read.") from None
    if ext not in _FORMAT_EXTS.get(fmt, frozenset()):
        raise NotAnImage(f"That file is {fmt or 'an unknown format'} inside, "
                         f"not {ext.lstrip('.').upper()}.")


# --- the blob write (spec 13.3) -------------------------------------------

def blob_put(path: str, body: bytes, content_type: str, _retry: bool = True) -> int:
    """Never overwrites: If-None-Match:* makes a colliding name fail instead.
    Content-Length is set by urllib from the body; x-ms-date is not required
    under bearer auth."""
    url = f"{blob_base_url()}/{urllib.parse.quote(path)}"
    req = urllib.request.Request(url, data=body, method="PUT")
    req.add_unredirected_header("Authorization", f"Bearer {storage_token()}")
    req.add_unredirected_header("x-ms-version", STORAGE_API_VERSION)
    req.add_unredirected_header("x-ms-blob-type", "BlockBlob")
    req.add_unredirected_header("Content-Type", content_type)
    req.add_unredirected_header("If-None-Match", "*")
    try:
        with _opener.open(req, timeout=120) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        if e.code in (401, 403) and _retry:
            _token_cache.update(tok=None, exp=0.0)  # stale token; keep the backoff
            return blob_put(path, body, content_type, _retry=False)
        raise


# Azure's docs disagree with themselves on the status for an unmet If-None-Match
# on a write (412 per the conditional-headers reference, 409 BlobAlreadyExists
# per the error-code list), so treat both as "that name is taken".
_COLLISION_STATUSES = (409, 412)


# --- routes ---------------------------------------------------------------

def _upload_pets() -> list:
    try:
        return [{"slug": p["slug"], "name": p["name"]} for p in get_model()["pets"]]
    except Exception:
        app.logger.exception("upload page could not build the pet list")
        return []


# Which blob-read mode is live, and where durable state landed. Both degrade
# silently otherwise, and after sealing the container the anonymous fallback is
# the difference between a real 403 and a misleading 404.
app.logger.warning("blob reads: %s; state dir: %s",
                   "MI + anonymous fallback (pre-seal)" if ALLOW_ANON_BLOB_READ
                   else "managed identity only",
                   STATE_DIR if STATE_DIR != THUMB_DIR
                   else f"{STATE_DIR} (DEGRADED — not durable across restarts)")

if UPLOAD_ENABLED:
    # Say out loud who may upload, so a mis-set app setting is visible in the
    # log at startup instead of only as a 403 someone has to reproduce.
    _allow = sorted(upload_allowlist())
    app.logger.info("/upload registered; allowed principals: %s",
                    ", ".join(_allow) if _allow
                    else "(unset — any principal Entra admits)")

    @app.route("/upload")
    @require_upload_auth
    def upload_page():
        oid, name = _principal_now()
        app.logger.info("upload page opened by %s (%s)", name, oid)
        # Carries a principal-bound CSRF token and the signed-in name, so it must
        # not sit in the back/forward cache of a shared phone after sign-out.
        resp = make_response(render_template(
            "upload.html",
            pets=_upload_pets(),
            csrf_token=csrf_mint(oid),
            who=name,
            max_bytes=UPLOAD_MAX_BYTES,
            min_year=UPLOAD_MIN_YEAR,
            now_month=current_month(),
        ))
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.route("/upload/inspect", methods=["POST"])
    @require_upload_auth
    def upload_inspect():
        """Preflight so the review list can show the date the *server* derives.
        The client posts the first ~128 KB (EXIF APP1 always lives there); the
        same resolve_taken() then serves both this and the real upload."""
        # Only the head is ever read, so refuse a body that could only be a
        # whole file: MAX_CONTENT_LENGTH alone would let 25 MB per photo cross
        # the wire for nothing.
        if request.content_length is None:
            return upload_error(411, "length_required",
                                "The upload did not declare its size.")
        if request.content_length > INSPECT_MAX_BYTES + 64 * 1024:
            return upload_error(413, "too_large",
                                "The date preflight only needs the start of the file.")
        part = request.files.get("head")
        name = os.path.basename((request.form.get("filename")
                                 or (part.filename if part else "") or "").replace("\\", "/"))
        ext = os.path.splitext(name)[1].lower()
        if ext in HEIC_EXTS:
            return upload_error(415, "heic_unsupported",
                                "HEIC photos aren't supported yet; switch the camera to JPEG.",
                                file=name)
        if ext not in IMAGE_EXTS:
            return upload_error(415, "unsupported_type",
                                "Only JPEG, PNG and WebP photos can be uploaded.", file=name)
        head = part.read(INSPECT_MAX_BYTES) if part else b""
        try:
            taken, source = resolve_taken(name, head)
        except (DateUndetermined, BadOverride):
            taken, source = None, None
        return jsonify({"ok": True, "file": name, "taken": taken, "source": source})

    @app.route("/upload", methods=["POST"])
    @require_upload_auth
    def upload_post():
        oid, who = _principal_now()
        if request.content_length is None:
            return upload_error(411, "length_required",
                                "The upload did not declare its size.")
        part = request.files.get("photo")
        if part is None or not part.filename:
            return upload_error(400, "no_file", "No photo was received.")
        fname = os.path.basename(part.filename.replace("\\", "/"))

        pet_slug = (request.form.get("slug") or "").strip()
        try:
            known = {p["slug"] for p in get_model()["pets"]}
        except Exception:
            return upload_error(503, "storage_error",
                                "The site can't reach storage right now — try again shortly.",
                                file=fname)
        # Membership in the live model, not a regex; the shape check is only so a
        # folder name that somehow contains a separator cannot reach the path.
        if pet_slug not in known or not PET_SLUG_RE.fullmatch(pet_slug):
            return upload_error(400, "unknown_pet", "Pick a pet from the list.", file=fname)

        ext = os.path.splitext(fname)[1].lower()
        if ext in HEIC_EXTS:
            return upload_error(415, "heic_unsupported",
                                "HEIC photos aren't supported yet; switch the camera to JPEG.",
                                file=fname)
        if ext not in IMAGE_EXTS:
            return upload_error(415, "unsupported_type",
                                "Only JPEG, PNG and WebP photos can be uploaded.", file=fname)

        body = part.read(UPLOAD_MAX_BYTES + 1)
        if len(body) > UPLOAD_MAX_BYTES:
            return upload_error(413, "too_large", "That photo is larger than 25 MB.",
                                file=fname)
        if not body:
            return upload_error(400, "empty_file", "That file was empty.", file=fname)
        try:
            verify_image(body, ext)
        except NotAnImage as e:
            return upload_error(415, "unsupported_type", str(e), file=fname)

        override = (request.form.get("taken_override") or "").strip()
        try:
            taken, source = resolve_taken(fname, body, override or None)
        except BadOverride:
            return upload_error(400, "bad_date",
                                f"{override or 'That date'} isn't a month between "
                                f"{UPLOAD_MIN_YEAR}-01 and {max_taken_month()}.", file=fname)
        except DateUndetermined:
            return upload_error(422, "date_required",
                                "This photo has no date in it — pick a year and month.",
                                file=fname)

        body = strip_gps(body, ext)
        content_type = CONTENT_TYPES[ext]

        blob_path = ""
        for n in range(1, 100):
            safe_name = build_safe_name(fname, taken, n)
            blob_path = f"{pet_slug}/gallery/{safe_name}"
            if not BLOB_PATH_RE.fullmatch(blob_path):
                app.logger.error("refusing to write a malformed path %r", blob_path)
                return upload_error(500, "server_error",
                                    "That photo's name could not be made safe.", file=fname)
            try:
                blob_put(blob_path, body, content_type)
            except urllib.error.HTTPError as e:
                if e.code in _COLLISION_STATUSES:
                    continue
                app.logger.error("blob PUT %s failed: %s", blob_path, e)
                return upload_error(502, "storage_error",
                                    "Storage refused the upload — try again.", file=fname)
            except Exception:
                app.logger.exception("blob PUT %s failed", blob_path)
                return upload_error(502, "storage_error",
                                    "Storage refused the upload — try again.", file=fname)
            break
        else:
            return upload_error(409, "name_conflict",
                                "There are already 99 photos with that name.", file=fname)

        invalidate_model()
        app.logger.info("upload: %s wrote %s (date from %s)", who, blob_path, source)
        return jsonify({"ok": True, "file": fname, "blob": blob_path,
                        "name": safe_name, "taken": taken, "source": source,
                        "renamed": safe_name != build_safe_name(fname, taken)}), 201

else:  # pragma: no cover - depends on the deployment environment
    app.logger.warning("/upload not registered: the Easy Auth module is not in the "
                       "request path (WEBSITE_AUTH_ENABLED not true, or authV2's "
                       "platform.enabled is not true)")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
