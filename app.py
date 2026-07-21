from __future__ import annotations

import hashlib
import io
import json
import os
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_file
from PIL import Image, ImageOps

app = Flask(__name__)

DEFAULT_BLOB_BASE_URL = "https://animalwebsitestg.blob.core.windows.net/pets"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
MODEL_CACHE_TTL = 60  # seconds
THUMB_DIR = Path(os.environ.get("THUMB_CACHE_DIR", "/tmp/petthumbs"))
THUMB_WIDTHS = {320, 480, 800, 1200}

# Gallery files named like 2022-06_lakeday.jpg (or 2022-06-14_lakeday.jpg) are
# placed on the timeline at that date; anything else falls back to blob
# Last-Modified (upload time).
DATE_PREFIX_RE = re.compile(r"^(\d{4})-(\d{2})(?:-(\d{2}))?[_-]")
SAFE_IMG_PATH_RE = re.compile(
    r"^[a-z0-9_-]+/(?:gallery/[^/\\]+|headshot\.(?:jpg|jpeg|png|webp))$", re.I
)

# Accent fallback rotation for pets whose meta.json omits "color".
FALLBACK_COLORS = ["#8A4E76", "#C9718A", "#3F7D77", "#C98A3D", "#5B7FA6", "#A6702E"]

_model_cache: dict = {"at": 0.0, "model": None}


def blob_base_url() -> str:
    return os.environ.get("BLOB_BASE_URL", DEFAULT_BLOB_BASE_URL).rstrip("/")


def _fetch(url: str, timeout: int = 10) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read()


def _fetch_blob(path: str, timeout: int = 10) -> bytes | None:
    try:
        return _fetch(f"{blob_base_url()}/{urllib.parse.quote(path)}", timeout)
    except Exception:
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
    m = DATE_PREFIX_RE.match(filename)
    if m:
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


def build_model() -> dict:
    base = blob_base_url()
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
                "url": f"{base}/{blobname}",
                "thumb": f"/img?path={urllib.parse.quote(blobname)}&w=480",
                "large": f"/img?path={urllib.parse.quote(blobname)}&w=1200",
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
            "headshot_url": f"{base}/{raw['headshot']}",
            "headshot_thumb": f"/img?path={urllib.parse.quote(raw['headshot'])}&w=480",
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

    return {
        "generated": datetime.utcnow().isoformat() + "Z",
        "trailhead_month": union_month,
        "now_month": now_month,
        "pets": pets,
        "events": events,
    }


def get_model() -> dict:
    now = time.time()
    if _model_cache["model"] is not None and now - _model_cache["at"] < MODEL_CACHE_TTL:
        return _model_cache["model"]
    try:
        model = build_model()
    except Exception:
        if _model_cache["model"] is not None:
            return _model_cache["model"]  # stale beats broken
        raise
    _model_cache.update(at=now, model=model)
    return model


@app.route("/")
def journey():
    return render_template("journey.html", journey=get_model())


@app.route("/api/journey")
def api_journey():
    return jsonify(get_model())


@app.route("/pets/<slug>")
def pet_detail(slug):
    pet = next((p for p in get_model()["pets"] if p["slug"] == slug), None)
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
    if width not in THUMB_WIDTHS or not SAFE_IMG_PATH_RE.match(path):
        abort(400)

    key = hashlib.sha1(f"{path}|{width}".encode()).hexdigest()
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    cached = THUMB_DIR / f"{key}.jpg"
    if not cached.exists():
        data = _fetch_blob(path, timeout=20)
        if data is None:
            abort(404)
        try:
            im = Image.open(io.BytesIO(data))
            im = ImageOps.exif_transpose(im)
            im.thumbnail((width, width * 2))
            im.convert("RGB").save(cached, "JPEG", quality=82)
        except Exception:
            abort(415)
    return send_file(cached, mimetype="image/jpeg", max_age=86400)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
