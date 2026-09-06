"""Tests for tools/gen_alpine_placeholders.py. Covers the plan's seven placeholder-generator scenarios.

Run with:

    venv/bin/python -m pytest tests/test_placeholders.py -v

Every test works on a temp-directory copy of the manifest and art (either a
small hand-picked subset for the idempotency check, or one full generation
of the real manifest shared read-only across the slower tests via a
session-scoped fixture) — the committed manifest and art under
static/images/alpine/ are only ever read, never written, by this file.
"""
import json
import random
import shutil
from pathlib import Path

import pytest
from PIL import Image

from tests._support import REAL_MANIFEST_PATH as REAL_MANIFEST  # noqa: E402  (adds the repo root to sys.path)

import tools.gen_alpine_placeholders as gen  # noqa: E402

# Column/row sampling stride used by the seam-wrap test, and the tolerance
# for comparing a wrap pair against typical interior adjacent-column noise.
# Calibrated against the real generated set: lossy WebP round-trips a
# genuinely seamless (torus-wrapped, pre-compression-periodic) tile with an
# edge-column compression artifact of up to ~30 (mean abs diff across
# RGBA channels) for this sparse ink-grain content, even at quality 100 —
# an unwrapped/broken tile shows 100+ for the same content. 45 sits
# comfortably above the observed noise floor and well below a real seam.
SEAM_ABS_TOLERANCE = 45
SEAM_RELATIVE_FACTOR = 3.0


def _write_manifest(path: Path, data: dict):
    path.write_text(json.dumps(data, indent=2) + "\n")


def _subset_manifest(tmp_path: Path, file_names) -> Path:
    """A trimmed copy of the real manifest with only the named assets, so
    the idempotency test (which draws everything twice) stays fast."""
    data = json.loads(REAL_MANIFEST.read_text())
    data["assets"] = [a for a in data["assets"] if a["file"] in file_names]
    assert len(data["assets"]) == len(list(file_names)), "subset file name not found in manifest"
    out = tmp_path / "manifest.json"
    _write_manifest(out, data)
    return out


@pytest.fixture(scope="session")
def manifest_data():
    return gen.load_manifest(REAL_MANIFEST)


@pytest.fixture(scope="session")
def generated(tmp_path_factory):
    """Generate the full real manifest's 18 assets once, into a session-
    scoped temp directory shared read-only by the slower tests below, so
    the (several-second) full draw only happens once per test run and the
    committed manifest/art are never touched."""
    work = tmp_path_factory.mktemp("alpine_full")
    manifest_path = work / "manifest.json"
    shutil.copy(REAL_MANIFEST, manifest_path)
    out_dir = work / "out"
    gen.generate(manifest_path, out_dir)
    return manifest_path, out_dir


def _fresh_case(tmp_path, generated_fixture, name="case"):
    """Copy the shared generated set into a scratch dir a test can mutate
    without disturbing the session fixture or any other test."""
    manifest_path, out_dir = generated_fixture
    work = tmp_path / name
    shutil.copytree(out_dir, work)
    local_manifest = tmp_path / f"{name}-manifest.json"
    shutil.copy(manifest_path, local_manifest)
    return local_manifest, work


# ---------------------------------------------------------------------------
# 1. Running the generator twice produces identical bytes for every file.
# ---------------------------------------------------------------------------
def test_generate_is_idempotent(tmp_path):
    subset = ["ground-overlay-a.webp", "grass-clumps.webp", "water-tile.webp"]
    manifest_path = _subset_manifest(tmp_path, subset)
    out1, out2 = tmp_path / "out1", tmp_path / "out2"
    gen.generate(manifest_path, out1)
    gen.generate(manifest_path, out2)
    for file_name in subset:
        b1 = (out1 / file_name).read_bytes()
        b2 = (out2 / file_name).read_bytes()
        assert b1 == b2, f"{file_name} differed between two generate() runs"


# ---------------------------------------------------------------------------
# 2. --check passes on a fresh run and fails naming the file when one
#    asset is deleted.
# ---------------------------------------------------------------------------
def test_check_passes_on_fresh_generation(generated):
    manifest_path, out_dir = generated
    ok, problems = gen.check(manifest_path, out_dir, quiet=True)
    assert ok, problems


def test_check_fails_naming_file_when_asset_deleted(tmp_path, generated):
    manifest_path, work = _fresh_case(tmp_path, generated)
    victim = gen.load_manifest(manifest_path)["assets"][0]["file"]
    (work / victim).unlink()
    ok, problems = gen.check(manifest_path, work, quiet=True)
    assert not ok
    assert any(victim in p for p in problems), problems


# ---------------------------------------------------------------------------
# 3. --check fails and names the category when one asset is inflated past
#    its cap while the total stays under 1.5 MB.
# ---------------------------------------------------------------------------
def test_check_fails_naming_category_when_asset_inflated(tmp_path, generated):
    manifest_path, work = _fresh_case(tmp_path, generated)
    data = gen.load_manifest(manifest_path)
    target = next(a for a in data["assets"] if a["file"] == "water-highlight.webp")
    cap = data["caps"][target["category"]]["per_file"]
    path = work / target["file"]
    path.write_bytes(path.read_bytes() + b"\x00" * (cap + 5000))

    total = sum((work / a["file"]).stat().st_size for a in data["assets"])
    assert total < data["total_cap"], "test setup should keep the total under the manifest cap"

    ok, problems = gen.check(manifest_path, work, quiet=True)
    assert not ok
    assert any(target["file"] in p and target["category"] in p for p in problems), problems


# ---------------------------------------------------------------------------
# 4. After replacing one file with different bytes, --rehash changes only
#    that entry's hash.
# ---------------------------------------------------------------------------
def test_rehash_changes_only_touched_entry(tmp_path, generated):
    manifest_path, work = _fresh_case(tmp_path, generated)
    before = gen.load_manifest(manifest_path)
    before_hashes = {a["file"]: a["hash"] for a in before["assets"]}

    victim = "grass-clumps.webp"
    path = work / victim
    path.write_bytes(path.read_bytes() + b"\x01\x02\x03\x04")

    changed = gen.rehash(manifest_path, work, quiet=True)
    assert changed == [victim], changed

    after = gen.load_manifest(manifest_path)
    after_hashes = {a["file"]: a["hash"] for a in after["assets"]}
    assert after_hashes[victim] != before_hashes[victim]
    for file_name, old_hash in before_hashes.items():
        if file_name != victim:
            assert after_hashes[file_name] == old_hash, f"{file_name} hash changed unexpectedly"


# ---------------------------------------------------------------------------
# 5. Every atlas cell's opaque pixels stay inside its cell minus the 2 px
#    padding: the padding ring is transparent, and nothing opaque sits
#    outside every cell rectangle.
# ---------------------------------------------------------------------------
def test_atlas_cells_respect_padding(generated, manifest_data):
    manifest_path, out_dir = generated
    pad = manifest_data["cell_padding_px"]
    alpha_tol = 6  # small allowance for lossy WebP alpha-channel quantization

    atlas_assets = [a for a in manifest_data["assets"] if a.get("cells")]
    assert atlas_assets, "expected at least one cell-based sheet in the manifest"

    for asset in atlas_assets:
        im = Image.open(out_dir / asset["file"]).convert("RGBA")
        w, h = im.size
        cells = asset["cells"]
        px = im.load()

        # 5a. The 2 px padding ring inside every cell is (near) fully transparent.
        for cell in cells:
            cx, cy, cw, ch = cell["x"], cell["y"], cell["w"], cell["h"]
            for y in range(cy, cy + ch):
                in_y_ring = y < cy + pad or y >= cy + ch - pad
                xs = range(cx, cx + cw) if in_y_ring else \
                    list(range(cx, cx + pad)) + list(range(cx + cw - pad, cx + cw))
                for x in xs:
                    a = px[x, y][3]
                    assert a <= alpha_tol, (
                        f"{asset['file']} cell {cell['name']!r} padding ring pixel "
                        f"({x},{y}) has alpha {a}, expected <= {alpha_tol}")

        # 5b. No opaque pixel anywhere on the sheet lies outside every cell rect.
        mask = Image.new("L", (w, h), 0)
        from PIL import ImageDraw
        md = ImageDraw.Draw(mask)
        for cell in cells:
            md.rectangle([cell["x"], cell["y"], cell["x"] + cell["w"] - 1, cell["y"] + cell["h"] - 1], fill=255)
        alpha_channel = im.getchannel("A")
        offenders = 0
        for m, a in zip(mask.getdata(), alpha_channel.getdata()):
            if m == 0 and a > alpha_tol:
                offenders += 1
        assert offenders == 0, f"{asset['file']} has {offenders} opaque pixel(s) outside every cell rectangle"


# ---------------------------------------------------------------------------
# 6. Seamless tiles wrap: left edge column equals right edge column and top
#    equals bottom within a tolerance (lossy WebP, so compare against the
#    typical interior adjacent-column/row difference rather than requiring
#    exact equality).
# ---------------------------------------------------------------------------
def _sampled_diff(get_line, w_or_h, i1, i2, step):
    total, n = 0, 0
    for t in range(0, w_or_h, step):
        p1, p2 = get_line(i1, t), get_line(i2, t)
        total += sum(abs(a - b) for a, b in zip(p1, p2))
        n += 1
    return total / n if n else 0.0


def test_seamless_tiles_wrap(generated, manifest_data):
    manifest_path, out_dir = generated
    seamless_assets = [a for a in manifest_data["assets"] if a["seamless"]]
    assert seamless_assets, "expected at least one seamless asset in the manifest"
    sample_rng = random.Random("seam-wrap-sampling")

    for asset in seamless_assets:
        im = Image.open(out_dir / asset["file"]).convert("RGBA")
        w, h = im.size

        # --- horizontal wrap: column 0 vs column w-1 ---
        ystep = max(1, h // 256)
        get_col = lambda c, y: im.getpixel((c, y))  # noqa: E731
        d_wrap_x = _sampled_diff(get_col, h, 0, w - 1, ystep)
        interior_ks = sample_rng.sample(range(max(1, w // 8), max(2, 7 * w // 8)), min(20, max(1, w // 8)))
        d_adj_x = sum(_sampled_diff(get_col, h, k, k + 1, ystep) for k in interior_ks) / len(interior_ks)
        tol_x = max(d_adj_x * SEAM_RELATIVE_FACTOR, SEAM_ABS_TOLERANCE)
        assert d_wrap_x <= tol_x, (
            f"{asset['file']} horizontal seam: col0/col{w-1} diff {d_wrap_x:.1f} "
            f"exceeds tolerance {tol_x:.1f} (interior adjacent-column diff {d_adj_x:.1f})")

        # --- vertical wrap: row 0 vs row h-1 ---
        xstep = max(1, w // 256)
        get_row = lambda r, x: im.getpixel((x, r))  # noqa: E731
        d_wrap_y = _sampled_diff(get_row, w, 0, h - 1, xstep)
        interior_ks_y = sample_rng.sample(range(max(1, h // 8), max(2, 7 * h // 8)), min(20, max(1, h // 8)))
        d_adj_y = sum(_sampled_diff(get_row, w, k, k + 1, xstep) for k in interior_ks_y) / len(interior_ks_y)
        tol_y = max(d_adj_y * SEAM_RELATIVE_FACTOR, SEAM_ABS_TOLERANCE)
        assert d_wrap_y <= tol_y, (
            f"{asset['file']} vertical seam: row0/row{h-1} diff {d_wrap_y:.1f} "
            f"exceeds tolerance {tol_y:.1f} (interior adjacent-row diff {d_adj_y:.1f})")


# ---------------------------------------------------------------------------
# 7. Total bytes are under 1.5 MB; the test names the largest three files
#    when it fails.
# ---------------------------------------------------------------------------
def test_total_bytes_under_cap(generated, manifest_data):
    manifest_path, out_dir = generated
    sizes = [(a["file"], (out_dir / a["file"]).stat().st_size) for a in manifest_data["assets"]]
    total = sum(size for _, size in sizes)
    largest_three = sorted(sizes, key=lambda pair: -pair[1])[:3]
    cap = manifest_data["total_cap"]
    msg = (f"total art bytes {total} exceeds cap {cap}; "
           f"largest files: " + ", ".join(f"{name} ({size}B)" for name, size in largest_three))
    assert total <= cap, msg
