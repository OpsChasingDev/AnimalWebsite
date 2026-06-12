import os
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path

import yaml
from flask import Flask, abort, render_template

app = Flask(__name__)

PETS_FILE = Path(__file__).parent / "pets.yaml"
DEFAULT_BLOB_BASE_URL = "https://animalwebsitestg.blob.core.windows.net/pets"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
GALLERY_CACHE_TTL = 60  # seconds
_gallery_cache: dict[str, tuple[float, list[str]]] = {}


def blob_base_url() -> str:
    return os.environ.get("BLOB_BASE_URL", DEFAULT_BLOB_BASE_URL).rstrip("/")


def load_pets():
    with PETS_FILE.open() as f:
        pets = yaml.safe_load(f) or []
    base = blob_base_url()
    for pet in pets:
        pet["headshot_url"] = f"{base}/{pet['headshot']}"
    return pets


def list_gallery(slug: str) -> list[str]:
    """Anonymously list blobs under <slug>/gallery/, newest first, image types only."""
    cached = _gallery_cache.get(slug)
    if cached and time.time() - cached[0] < GALLERY_CACHE_TTL:
        return cached[1]

    base = blob_base_url()
    prefix = f"{slug}/gallery/"
    list_url = f"{base}?restype=container&comp=list&prefix={urllib.parse.quote(prefix)}"
    try:
        with urllib.request.urlopen(list_url, timeout=5) as resp:
            xml_bytes = resp.read()
    except Exception:
        # On failure, return stale cache if any, else empty.
        return cached[1] if cached else []

    root = ET.fromstring(xml_bytes)
    entries: list[tuple[datetime, str]] = []
    for blob in root.iter("Blob"):
        name = blob.findtext("Name") or ""
        ext = os.path.splitext(name)[1].lower()
        if ext not in IMAGE_EXTS:
            continue
        last_mod_text = blob.findtext("Properties/Last-Modified") or ""
        try:
            last_mod = parsedate_to_datetime(last_mod_text)
        except (TypeError, ValueError):
            last_mod = datetime.min
        entries.append((last_mod, f"{base}/{name}"))

    entries.sort(key=lambda t: t[0], reverse=True)
    urls = [u for _, u in entries]
    _gallery_cache[slug] = (time.time(), urls)
    return urls


@app.route("/")
def index():
    return render_template("index.html", pets=load_pets())


@app.route("/pets/<slug>")
def pet_detail(slug):
    pet = next((p for p in load_pets() if p["slug"] == slug), None)
    if pet is None:
        abort(404)
    pet["gallery_urls"] = list_gallery(slug)
    return render_template("detail.html", pet=pet)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
