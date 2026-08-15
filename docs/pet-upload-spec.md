# Spec: private-container hardening, then `/upload`

**Status:** ready to build. Azure side is already live (see
`pet-upload-handoff-response.md`); everything below is application code.
**Order changed 2026-08-14:** hardening ships **first**, uploads second. See §2.
**Supersedes:** §3 of `pet-upload-handoff.md`, which proposed silent
date-fallback-to-today. That is explicitly rejected — see §11.3.

---

## 1. The six required outcomes, and where each is met

| # | Outcome | Met by | Phase |
| --- | --- | --- | --- |
| 5 | Public anonymous blob access removed | §7 — container private + account flag off | **1** |
| 6 | Site reads blobs authenticated | §5–§6 — managed-identity bearer token on every read | **1** |
| 1 | Only Robert and Jordan can upload | §9 — Entra assignment (live) + route guard | 2 |
| 2 | Dates handled automatically | §11.1–11.2 — EXIF, then filename patterns | 2 |
| 3 | Undated photo behaviour | §11.3 — flagged in UI, year+month required, **never silently dated** | 2 |
| 4 | Server knows which pet | §12 — one pet per batch, slug validated server-side | 2 |

Outcome 1's Entra layer is already live and verified; only its route guard is
outstanding.

---

## 2. Phasing — and why the order was reversed

**Phase 1 — reads move to managed identity, container goes private.**
**Phase 2 — `/upload`.**

The original plan was the reverse. Doing hardening first costs one thing and
buys two.

**Cost.** The risky step happens before any new user-facing feature exists. If a
read path is missed the site renders empty. This is bounded: the rollback is a
single container-ACL command (§8), and the site's existing *"stale beats broken"*
model cache (`app.py:275–280`) already degrades to a stale page rather than an
error when blob reads fail.

**Buy 1 — the GPS exposure window disappears entirely.** Under the old order,
Phase 1 uploads would have landed in a *public* container, so an uploaded
original — including the home coordinates in its EXIF — was downloadable by
anyone holding the URL, with `/api/journey` publishing those URLs. Reversing the
order means every photo Jordan ever uploads arrives into an already-sealed
container. The concern raised in §14 is now largely structural rather than
urgent.

**Buy 2 — it de-risks the upload feature.** Phase 1 exercises managed-identity
token acquisition and container-scoped RBAC for *reads*. The same
`Storage Blob Data Contributor` role covers reads and writes, and the same token
helper serves both. So a working Phase 1 proves everything about the upload
write path except the HTTP verb itself — leaving Phase 2 with far less that can
surprise us.

---

## 3. Prerequisite — Robert's blob data access

**Applied 2026-08-14.** `Storage Blob Data Contributor` for
`robert@stapleton-family.net` (object `885b9268-3f25-4869-8014-9f97f9d13f3e`),
scoped to the `pets` container, matching the two web app identities.

**Why it was blocking:** subscription Owner does **not** grant blob data-plane
access — verified, `az storage blob list --auth-mode login` failed with an
authorization error before this. Anonymous access masks that today. The moment
§7 runs, CLI access and local dev break without this role, and local dev (§5)
depends on it.

> RBAC propagation takes a few minutes. Confirm with
> `az storage blob list --account-name animalwebsitestg -c pets --auth-mode login`
> before relying on it.

---

# PHASE 1 — hardening

## 4. What Phase 1 touches

Verified by grep across `templates/` and `static/`, not assumed:

- `app.py` — `_fetch()` gains auth; `_fetch_blob()` and `list_container()`
  inherit it unchanged.
- `templates/detail.html:22` — the **only** direct blob URL in rendered output.
- `app.py:168` and `app.py:189` — model fields that publish blob URLs via
  `/api/journey`. No JS in this repo consumes them.

That is the entire surface. Everything else already routes through the `/img`
proxy.

## 5. Token helper — shared by Phase 1 reads and Phase 2 writes

```python
_token_cache: dict = {"tok": None, "exp": 0.0}

def storage_token() -> str:
    if _token_cache["tok"] and time.time() < _token_cache["exp"] - 300:
        return _token_cache["tok"]
    endpoint, header = os.environ.get("IDENTITY_ENDPOINT"), os.environ.get("IDENTITY_HEADER")
    if endpoint and header:                      # App Service managed identity
        url = f"{endpoint}?resource=https://storage.azure.com/&api-version=2019-08-01"
        req = urllib.request.Request(url, headers={"X-IDENTITY-HEADER": header})
        data = json.loads(urllib.request.urlopen(req, timeout=10).read())
    else:                                        # local dev — developer's own az login
        out = subprocess.run(
            ["az", "account", "get-access-token", "--resource", "https://storage.azure.com/"],
            capture_output=True, text=True, check=True)
        data = json.loads(out.stdout)
    _token_cache.update(tok=data["access_token"], exp=float(data.get("expires_on", 0)))
    return _token_cache["tok"]
```

Still `urllib` and stdlib — no `azure-*` SDK, house style holds. Dependencies
stay `Flask`, `gunicorn`, `Pillow`.

The local-dev branch is why §3 was a prerequisite: it uses the developer's own
Entra identity, which now has the role. It is taken whenever `IDENTITY_ENDPOINT`
is absent — no extra flag — so `az login && python app.py` is all local dev
needs (README "Development"). If neither path is available the raised error says
which one was missing, rather than blaming managed identity for a missing
`az login`.

Two additions to the sketch above, both learned from review:

- The negative cache after a token failure is **short** (a few seconds, one
  attempt per worker per interval). A long negative cache turns a single blip on
  a *cold* instance — one with no stale model to fall back on — into a
  guaranteed outage window instead of a fast self-heal.
- `ALLOW_ANON_BLOB_READ` (default on) lets a read fall back to an unauthenticated
  GET while the container is still public. It exists only for the window between
  deploying this code and running §7; **set it to `0` in the same change that
  seals the container.**

## 6. Read path and template changes

### 6.1 Authenticated reads

`_fetch()` (`app.py:45`) gains `Authorization: Bearer <storage_token()>` and
`x-ms-version: 2021-08-06` (must be ≥ `2017-11-09` for Entra auth). Both callers
— `_fetch_blob()` (`app.py:50`) and `list_container()` (`app.py:57`) — inherit
it with no further edit.

Preserve the existing failure behaviour: `get_model()` serves a stale model when
`build_model()` throws. A token blip therefore degrades to a slightly stale page
rather than an empty site. Do not "clean this up".

### 6.2 The one template fix

```jinja
<img class="detail-photo" src="{{ pet.headshot_url }}">     <!-- before -->
<img class="detail-photo" src="{{ pet.headshot_large }}">   <!-- after  -->
```

Add `headshot_large` beside the existing `headshot_thumb` (`app.py:190`):

```python
"headshot_large": f"/img?path={urllib.parse.quote(raw['headshot'])}&w=800",
```

`800` is already in `THUMB_WIDTHS` (`app.py:25`), so nothing else changes.

### 6.3 Dead URL fields

Once the container is private, `photo["url"]` (`app.py:168`) and
`pet["headshot_url"]` (`app.py:189`) are unreachable for anyone but the app, yet
`/api/journey` still publishes them. Replace both with their `/img` proxy
equivalents so the public API contains no links that 403.

**Contract change, deliberate:** those two fields go from absolute blob URLs at
original resolution to **site-relative** proxy paths (`/img?path=…&w=1200`).
Nothing in this repo reads them (the JS uses `thumb`/`large`/`headshot_thumb`),
but any outside consumer must now join them to the site's own origin. There is
no `SITE_BASE_URL`: publishing an absolute URL would need an app setting nobody
had set, which silently degraded to the relative form anyway.

### 6.4 Where "stale beats broken" actually lives

The fallback is only as good as the snapshot it reads, and the snapshot used to
sit in `THUMB_CACHE_DIR` — `/tmp`, per-instance, wiped by every restart and
scale-out. On a *cold* instance there was no stale model at all, so a token blip
was a full-site 500 rather than a slightly stale page.

So the durable state (the last-good `model.json`, the cross-worker model stamp,
the CSRF key) is written to `/home/data/petsite` on App Service — `/home` is
persistent app storage — falling back to the thumbnail dir if that is not
writable. Override with `SITE_STATE_DIR`. Thumbnails stay in `/tmp`: they are a
cache, they are large, and local disk is faster.

Belt and braces: if the model cannot be built **and** there is no snapshot, `/`
and `/pets/<slug>` render a plain "the trail is loading" page (503) and
`/api/journey` returns a 503 envelope. A bare Werkzeug 500 is never the answer.

## 7. Sealing the container

Only after §5–§6 are deployed and confirmed in production:

```
az storage container set-permission --account-name animalwebsitestg -n pets \
    --public-access off --auth-mode login
az storage account update -g animalwebsite_group -n animalwebsitestg \
    --allow-blob-public-access false
```

Container ACL first, account flag second. The account flag is belt-and-braces:
with it off, no container in the account can be made public by accident later.

Set `ALLOW_ANON_BLOB_READ=0` on both web apps in the same change (§5): the
pre-seal fallback has no purpose once anonymous reads 403.

**Verification — all four must hold:**

```
curl -o /dev/null -w '%{http_code}' \
  'https://animalwebsitestg.blob.core.windows.net/pets?restype=container&comp=list'   # want 404/409
curl -o /dev/null -w '%{http_code}' \
  'https://animalwebsitestg.blob.core.windows.net/pets/lucy/headshot.jpg'             # want 404
curl -o /dev/null -w '%{http_code}' https://pets.stapleton-family.net/                # want 200
curl -o /dev/null -w '%{http_code}%{content_type}' \
  'https://pets.stapleton-family.net/img?path=lucy%2Fheadshot.jpg&w=480'              # want 200 image/jpeg
```

**The fourth is the one that matters, and it must be run after a restart.** A
`200` on `/` is *not* evidence that the reads work: the app deliberately serves
the last-good model when a build fails, and `/img` serves any derivative already
in its on-disk cache — so a site whose storage auth is completely broken still
answers `200` on `/` with every image missing. Restarting clears the thumbnail
cache (it lives in `/tmp`), so a `200 image/jpeg` on a real gallery blob after a
restart is the check that actually exercises an authenticated read. The
model-build failure and every non-404 blob read now log at ERROR, so the log is
the second signal.

## 8. Phase 1 cutover and rollback

**Staging and production share the `pets` container.** That shapes the sequence:

1. Ship §5–§6 to `staging`. The container is still public, so this is a free
   rehearsal — it proves the token path works before anything is sealed.
2. Confirm staging renders, including a detail page (the `detail.html:22`
   regression) and `/api/journey`.
3. Promote to production. Confirm both sites render.
4. **Only then** run §7. Because the container is shared, the ACL flip hits both
   sites at once — so both must be healthy on the §6 code first.

**Rollback for the risky step is one command:**

```
az storage container set-permission --account-name animalwebsitestg -n pets \
    --public-access container --auth-mode login
```

---

# PHASE 2 — `/upload`

## 9. Outcome 1 — only Robert and Jordan can upload

Two independent layers. Either alone would do; both together mean a single
mistake is not a breach.

### 9.1 Layer 1 — Entra (live, already verified)

`AnimalWebsite Upload` has **Assignment required = Yes** with exactly two users
assigned. Anyone else is refused a token by Entra and never reaches Flask.
Adding or removing an uploader is an Entra assignment change — no code, no
deploy.

### 9.2 Layer 2 — route guard

Easy Auth runs as `AllowAnonymous` so the public site stays public, which means
**the app must enforce on `/upload` itself.** Easy Auth injects these on
authenticated requests and strips any client-supplied copies, so they are safe
to trust:

```
X-MS-CLIENT-PRINCIPAL-ID      # stable object id
X-MS-CLIENT-PRINCIPAL-NAME    # e.g. jordan@stapleton-family.net
```

The implemented guard (`upload_guard()` in `app.py`) is stricter than the sketch
this spec first carried. It verifies rather than trusts-by-presence:

- the provider is `aad` in **both** `X-MS-CLIENT-PRINCIPAL-IDP` and the decoded
  claims blob (compared case-insensitively);
- the base64 claims blob decodes and carries an object id;
- `X-MS-CLIENT-PRINCIPAL-ID` is **present and equal** to that object id;
- writes additionally require `Sec-Fetch-Site: same-origin`, an `Origin` in the
  allowlist, and a valid HMAC CSRF token bound to the object id.

**Every** route in the upload feature carries `@require_upload_auth` —
`GET /upload`, `POST /upload`, and anything added later — and a `before_request`
backstop runs the same guard for the whole `/upload` namespace, so a route that
forgets the decorator still fails closed.

`UPLOAD_ALLOWED_PRINCIPALS` is **optional and unset by default**. Unset means
"any principal Entra let through", keeping Entra assignment (§9.1) as the single
source of truth for who may upload. Set it only if you want a second, code-side
lock; the values are matched, lowercased, against the caller's **object id or
sign-in name**, so either style works:

```
UPLOAD_ALLOWED_PRINCIPALS=885b9268-3f25-4869-8014-9f97f9d13f3e,jordan@stapleton-family.net
```

(Object ids are the better choice — a sign-in name derives from a configurable
`nameClaimType`. Robert's is `885b9268-3f25-4869-8014-9f97f9d13f3e`; look
Jordan's up with `az ad user show --id jordan@stapleton-family.net --query id`.)
Whichever way it is set, the value in force is logged once at startup, so a
mis-set setting is visible without reproducing the 403.

**Fail-closed — but not for the reason first written here.** These headers are
read straight off the request; the app has no way to check their provenance. The
*only* thing that makes them trustworthy is the Easy Auth module sitting in the
request path and stripping client-supplied copies. So the routes are not
registered at all unless the module is running: `EASY_AUTH_RUNNING` **parses**
`WEBSITE_AUTH_V2_CONFIG_JSON` and requires `platform.enabled == true`, and
requires `WEBSITE_AUTH_ENABLED` not to contradict it. Presence of the config
variable is not enough — it mirrors ARM and survives turning auth off, so a
portal toggle would otherwise leave `/upload` live with forgeable headers.

Every successful upload logs the principal, giving an audit trail of who added
what.

## 10. Page flow

Open `/upload` → pick pet → pick photos (Android multi-select) → review dates →
Upload. Mobile-first, installable to the home screen.

## 11. Outcomes 2 and 3 — dates

### 11.1 Resolution order

`resolve_taken()` returns `"YYYY-MM"` or raises `DateUndetermined`:

1. **Explicit override from the client.** Validated
   `^\d{4}-(0[1-9]|1[0-2])$`, from `1990-01` up to **one month past the current
   UTC month**. Wins over everything — it exists so Jordan can correct a camera
   with a wrong clock. The month of slack is deliberate: the server clock is
   UTC, and a photo taken just after local midnight on the 1st in a UTC-ahead
   zone carries next month, which must not be discarded as undatable. The page's
   own selectors stop at the current month, so the slack is only ever reached by
   an EXIF or filename date.
2. **EXIF `DateTimeOriginal`** (tag 36867) via Pillow, already a dependency and
   already used in `img_proxy`. Format `YYYY:MM:DD HH:MM:SS` → year+month. Fall
   back to `DateTimeDigitized` (36868).
3. **Filename patterns**, in order:
   - `^(\d{4})-(\d{2})(?:-(\d{2}))?[_-]` — already-prefixed, matches the
     existing `DATE_PREFIX_RE`
   - `^PXL_(\d{4})(\d{2})(\d{2})_` — Pixel
   - `^IMG_(\d{4})(\d{2})(\d{2})[_-]` — generic camera / WhatsApp
   - `^(\d{4})(\d{2})(\d{2})[_-]` — bare datestamp
4. **Nothing matched** → raise. **Never fall back to today.**

> **Pixel UTC caveat** (handoff §6.4): `PXL_` filenames are UTC, so a photo taken
> late on the last evening of a month can carry the next month's date. EXIF is
> checked first precisely because it is local time, so this only bites for
> photos stripped of EXIF. Harmless at month granularity.

### 11.2 Server is authoritative

The client sends its resolved date, but the server re-runs steps 2–4 itself and
trusts the client only for the explicit override in step 1, which is
range-validated. A malformed or out-of-range override is a `400`, not a silent
correction.

### 11.3 Outcome 3 — what happens with no derivable date

**The upload is refused until a human supplies the date. It is never guessed.**

- **Server:** `resolve_taken()` raises → `422` with
  `{"error": "date_required", "file": "<name>"}`. No blob is written.
- **Client:** the review list shows each photo with the year+month it detected,
  editable. Photos where detection failed are flagged ("needs a date") and the
  **Upload button stays disabled** until each has one.
- **Control:** a **year selector and a month selector**. Year runs 1990 to the
  current year and defaults to blank when undetected, so nothing is accidentally
  accepted. Year is included deliberately — these are often old photos, and the
  year is the part that matters.
- An "apply to all flagged photos" shortcut, since a batch of scans is usually
  from one era.

Net effect: a photo can only ever be dated by EXIF, by its own filename, or by a
deliberate human choice.

This rejects the handoff's proposed fallback-to-today, which is the exact failure
`pet-upload-handoff.md` §2 identified — undated old photos collapsing into the
current month — made worse by being silent.

### 11.4 Independent fix — display-side fallback

Separately from upload, teach the existing `_photo_date()` (`app.py:103`) the
`PXL_`/`IMG_`/bare-datestamp patterns from §11.1 step 3, so a raw Pixel photo
self-dates however it arrived in the container — including files placed there
before this feature existed.

The sanity bounds (1990..next year) apply to those **inferred** patterns only. An
explicit `YYYY-MM_` prefix is a deliberate human statement about the date — the
trail's endnote documents it with no year restriction — so it keeps its previous
unconditional behaviour and a 1974 scan still lands in 1974. Display bounds and
upload bounds are separate on purpose; do not share one constant between them.

## 12. Outcome 4 — how the server knows which pet

**One pet per batch.**

- The dropdown is built from the live model, `get_model()["pets"]`, so it always
  matches reality — no hardcoded list to drift.
- Each `POST /upload` carries `slug` alongside its one photo.
- The server validates `slug` against
  `{p["slug"] for p in get_model()["pets"]}` — **membership in the known set**,
  not a regex. An unknown slug is `400` and nothing is written.
- The path is assembled server-side only:

```python
blob_path = f"{slug}/gallery/{safe_name}"
```

The client never supplies a path, folder, or prefix. Because `slug` must be a
known pet and `safe_name` is regenerated from scratch (§13.1), **a request cannot
write outside some pet's gallery** — not via `../`, not via a leading slash, not
via a crafted filename.

Mixed batches mean two trips. That was the agreed trade for a simpler page on a
phone.

## 13. Upload mechanics

### 13.1 Filename construction

```python
base, ext = os.path.splitext(original_name)
ext = ext.lower()
if ext not in IMAGE_EXTS:          # {.jpg, .jpeg, .png, .webp}
    abort(415)
base = strip_leading_datestamp(base)          # avoid 2025-08_PXL_20250814_...
slug = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-")[:48] or "photo"
safe_name = f"{taken}_{slug}{ext}"            # 2025-08_pxl-20250814-183045123.jpg
```

The `YYYY-MM_` prefix is what places the photo on the timeline — read back by the
existing `DATE_PREFIX_RE` with no further change.

### 13.2 One photo per request

The client fires photos sequentially so each request stays at 3–5 MB, the UI
shows per-photo progress, and one failure doesn't lose the batch. Verified safe:
gunicorn's timeout is 600s (App Service default, no custom startup command) and
the plan is Basic B2. Server-side cap: reject a body over **25 MB** with `413`.

### 13.3 Writing the blob

```
PUT https://animalwebsitestg.blob.core.windows.net/pets/<slug>/gallery/<safe_name>
    Authorization:   Bearer <storage_token()>     # the §5 helper, already proven in Phase 1
    x-ms-blob-type:  BlockBlob
    x-ms-version:    2021-08-06
    Content-Type:    image/jpeg
    If-None-Match:   *
```

### 13.4 Collisions — never overwrite

`If-None-Match: *` makes the write fail with `409 BlobAlreadyExists` rather than
clobbering. On 409, retry as `<name>-2`, `-3`, … up to `-99`, then fail with a
clear error.

**Decided, not asked:** silently overwriting a photo because two files produced
the same name is data loss, and the recovery is "restore from a backup that does
not exist." Suffixing costs one extra round trip in a rare case.

### 13.5 Cache invalidation

`MODEL_CACHE_TTL` is 60s (`app.py:23`), so a fresh upload would otherwise take up
to a minute to appear — which reads as "it didn't work" and invites a re-upload.
On a successful write, reset `_model_cache["at"] = 0` so the next page load
rebuilds.

### 13.6 Formats

`.heic` stays unsupported (handoff §6.5). Pixel shoots JPEG by default. If a HEIC
arrives, reject with an explicit message — *"HEIC photos aren't supported yet;
switch the camera to JPEG"* — not a generic failure. `pillow-heif` remains a
later option.

---

## 14. EXIF GPS — largely resolved by the reordering

Phone photos carry GPS coordinates, and pet photos are usually taken at home.

Under the original order this was urgent: uploads would have landed in a public
container, exposing home coordinates to anyone with the URL. **Reversing the
order removes that window** — every uploaded original arrives into an
already-sealed container, and the `/img` proxy re-encodes through Pillow and
drops EXIF, so only stripped derivatives are ever served publicly.

What remains is defence in depth: the original still carries GPS inside the
private container. Stripping the GPS IFD on ingest is a few lines and makes the
data simply not exist. **Recommended but no longer urgent** — worth folding into
§13 when convenient. No decision needed to start building.

---

## 15. Test plan

### Phase 1

- Staging renders on §5–§6 code while the container is still public.
- Detail page headshot loads — the `detail.html:22` regression.
- `/api/journey` contains no direct blob URLs.
- Both sites render **after** the container is sealed (§7 verification, all
  four checks).
- **Restart each app after sealing, then `GET /img?path=<a real gallery
  blob>&w=480` → `200 image/jpeg`.** This, not a status check on `/`, is the
  evidence that authenticated reads work: `/` renders from the last-good model
  and `/img` from its `/tmp` cache, both of which survive total storage failure.
- Anonymous blob list and anonymous blob GET both fail.
- `az storage blob list --auth-mode login` works for Robert (§3).
- Token expiry: a request after the cached token would have expired still works.
- Kill the token path deliberately (bad resource) and confirm the site serves a
  stale model rather than erroring — **and** that an ERROR line is logged.
- Kill the token path on an instance with no snapshot (delete `model.json` in
  the state dir, restart): `/`, `/pets/<slug>` and `/api/journey` return a
  friendly 503, never a bare 500 traceback.

### Phase 2

- Signed out, `/upload` redirects to Entra; after sign-in it returns.
- A tenant user who is *not* assigned is refused by Entra.
- `POST /upload` with no auth headers → redirect, no blob written.
- Pixel JPEG with EXIF → correct `YYYY-MM_` prefix from EXIF.
- EXIF stripped, `PXL_20250814_...` name → correct prefix from filename.
- Neither → `422 date_required`, **no blob written**; supplying year+month then
  succeeds.
- `slug` not in the known set → `400`, nothing written.
- Filename containing `../` or a leading `/` → lands in the right gallery anyway.
- Same photo twice → second becomes `-2`, first is intact.
- `.heic` → clear rejection message.
- Bytes that are not an image (a text file renamed `.jpg`, a truncated pick) →
  `415`, **nothing written** — otherwise the trail carries a tile that can never
  render and the phone UI has no way to remove it.
- JPEG bytes named `.png` → `415`; the extension decides the stored
  Content-Type, so it has to be true.
- A file over 25 MB in a multi-photo pick is marked "too large — it will be
  skipped" and does **not** disable the Upload button for the rest of the batch.
- Sign in from each hostname the site answers on (both custom domains and both
  `*.azurewebsites.net` default hosts) and upload one photo: no `bad_origin`.
- After upload, the photo appears on the trail within one page load.
- Upload works with the container private (it will already be sealed).
