# Handoff: phone-based pet photo uploads (`/upload`)

**Audience:** a local Claude Code session with Azure Global Admin, able to change
infrastructure.
**Written by:** remote session on branch `claude/pet-photos-blob-storage-pixel-z46z0f`.
**What is needed from you:** two authentication decisions (§4 and §5) plus the
Azure-side changes they imply. No application code has been written yet.

---

## 1. Goal

Robert's wife needs to add pet photos to the site from her **Google Pixel**, with
no laptop, no Azure account, and no filename rules to remember.

Proposal: an `/upload` page served by the existing Flask app, installable to her
home screen. Flow is: tap icon -> pick pet -> Android multi-select photo picker
-> Upload. The server derives the date, builds the filename, and writes the blob
to the correct path.

## 2. Current state (verified, not assumed)

Constants live in `.claude/project.yaml`:

| Thing | Value |
| --- | --- |
| Subscription | `61099367-dccb-464a-80c7-497ea6c3b0fd` |
| Tenant | `7a48ae9d-14ba-4845-b7f8-2cd9387bed48` |
| Resource group | `animalwebsite_group` |
| Storage account | `animalwebsitestg` |
| Container | `pets` |
| Prod web app | `animalwebsite` -> https://pets.stapleton-family.net |
| Staging web app | `animalwebsite-staging` -> https://staging-pets.stapleton-family.net |

Application facts:

- `app.py` is a read-only consumer of the container. There is **no write path,
  no credential, and no authentication anywhere in the codebase today.**
- The container is **anonymously readable *and* listable**. An unauthenticated
  `GET .../pets?restype=container&comp=list` returns HTTP 200. The app depends on
  this: `list_container()` (`app.py:56`) and `_fetch_blob()` (`app.py:49`) both
  call Azure with no credential.
- A photo's position on the timeline comes only from its filename prefix:
  `DATE_PREFIX_RE = ^(\d{4})-(\d{2})(?:-(\d{2}))?[_-]` (`app.py:31`). With no
  prefix, the app falls back to the blob's **Last-Modified**, i.e. upload time --
  so unprefixed old photos would all collapse into the current month. Automatic
  naming is the core of this feature, not a nicety.
- Dependencies are deliberately minimal: `Flask`, `gunicorn`, `Pillow`. The app
  hand-rolls Azure REST calls with `urllib` and `xml.etree`. There is **no
  `azure-*` SDK package in the project.**
- Container contents today: pets `belle`, `gracie`, `lucy`, `matilda` (each with
  `headshot.jpg` + `meta.json`); only `lucy` has gallery photos. Also
  `_trail/lore.json`.

## 3. Proposed application change (for context; not your call to make)

Once §4 and §5 are decided, the remote session implements on the feature branch:

1. `GET /upload` -- mobile-first page; pet dropdown from the existing model;
   `<input type="file" accept="image/*" multiple>`.
2. `POST /upload` -- **one photo per request** (client fires them sequentially)
   so each request stays small and the UI can show per-photo progress.
3. Server-side naming: read EXIF `DateTimeOriginal` via Pillow (already a
   dependency, already used in `img_proxy`) -> `YYYY-MM_`. Fall back to parsing
   the Pixel filename (`PXL_20250814_183045123.jpg`), then to today.
4. Server-side path construction: `<slug>/gallery/<name>`, slug validated against
   the known pet list, so a bad request cannot write outside a pet's gallery.
5. Blob write via whichever credential §4 selects.
6. Independent small fix: teach the date fallback to recognise `PXL_YYYYMMDD_`
   and `IMG_YYYYMMDD_` filenames, so a raw Pixel photo self-dates by any route.

---

## 4. DECISION ONE -- how the app authenticates to storage (write path)

### Option A: system-assigned managed identity  **(recommended)**

Admin actions:
1. Enable system-assigned managed identity on **both** `animalwebsite` and
   `animalwebsite-staging`.
2. Assign **`Storage Blob Data Contributor`** to each identity, scoped to the
   `pets` container (preferred) or the `animalwebsitestg` account.

App side: no new dependencies required. App Service injects `IDENTITY_ENDPOINT`
and `IDENTITY_HEADER`; the app can `GET ${IDENTITY_ENDPOINT}?resource=https://storage.azure.com/&api-version=2019-08-01`
with the `X-IDENTITY-HEADER` header, then `PUT` the blob with
`Authorization: Bearer <token>`, `x-ms-blob-type: BlockBlob`, and a recent
`x-ms-version`. This matches the existing hand-rolled-REST house style. Using
`azure-identity` + `azure-storage-blob` instead is also fine but adds two deps.

Pros: no secret exists anywhere, nothing to rotate, and it is the **only option
that leaves the door open to closing public access later** (see §6.1).

> **Gotcha:** Entra **Global Administrator does not by itself grant Azure RBAC
> rights.** Creating a role assignment needs `Microsoft.Authorization/roleAssignments/write`
> (Owner or User Access Administrator on the scope). If the account lacks it,
> elevate via Entra ID -> Properties -> "Access management for Azure resources"
> -> Yes, assign, then turn it back off.

### Option B: container-scoped SAS stored in app settings

Admin actions: mint a SAS on the `pets` container with **create + write** (`cw`)
permissions and a long expiry; store as app setting `BLOB_WRITE_SAS` on both web
apps.

App side: zero new dependencies -- a plain `PUT <blob-url>?<sas>`.

Pros: simplest to stand up. Cons: a real secret in app settings, expiry to
diarise, and rotation is manual. Note a **service/account SAS requires the
storage account key**, so this fails if "Allow storage account key access" is
disabled on the account; a *user delegation* SAS avoids the key but needs an
Entra identity anyway, at which point Option A is strictly better.

### Option C: storage account key in app settings

Not recommended. Grants full control of the entire account to the web app for no
benefit over B. Listed only so it is explicitly rejected.

**Recommendation: Option A.** Fall back to B only if the RBAC elevation in the
gotcha above is unacceptable.

---

## 5. DECISION TWO -- who is allowed to reach `/upload`

Currently the site is entirely public and has no login of any kind.

### Option A: shared secret in a bookmarked URL

`/upload?k=<long random>`, set as an app setting, exchanged for a signed
long-lived cookie. **Zero infrastructure work.** She bookmarks it once / adds to
home screen and never sees a login. Weakest option in theory; the practical
exposure is that anyone holding the link can write blobs.

### Option B: App Service Authentication ("Easy Auth") with Entra ID

Admin actions:
1. App registration in tenant `7a48ae9d-14ba-4845-b7f8-2cd9387bed48`.
2. Redirect URIs -- **both** the default hostname and the custom domain:
   - `https://animalwebsite.azurewebsites.net/.auth/login/aad/callback`
   - `https://pets.stapleton-family.net/.auth/login/aad/callback`
   - plus the staging equivalents for `animalwebsite-staging` /
     `staging-pets.stapleton-family.net`
3. Enable authentication on the web apps, "require authentication" for the
   `/upload` path only -- the rest of the site must stay anonymous.
4. Restrict access: set **"Assignment required"** on the enterprise application
   and assign only the two intended users.

> **Blocker to check first:** does his wife have an account in this tenant? If
> she does not, this needs either a B2B guest invitation or Google added as a
> federated identity provider in Easy Auth. If neither is palatable, Option A is
> the pragmatic answer.

> Easy Auth protects the whole site by default. Scoping it to `/upload` alone
> requires setting unauthenticated access to "allow" and enforcing the check in
> app code, or fronting only that route. Please confirm which you want.

### Option C: Easy Auth on production, shared key on staging

Lets her test on staging without an account while production stays properly
authenticated. Reasonable middle ground.

**Recommendation:** start at **Option A** for speed, move to **B** if you want it
done properly and the tenant-account question resolves cleanly.

---

## 6. Interactions and gotchas

### 6.1 Do NOT disable anonymous blob access without a code change

The storage account currently has public blob access enabled and the `pets`
container is at **container-level** (anonymous list) access. **`app.py` depends
on this.** Tightening it to "Blob" access breaks `list_container()` and the whole
site renders empty. Tightening it to "Private" additionally breaks `_fetch_blob()`
(meta.json, captions.txt, lore.json) and the `/img` proxy's source fetch.

Useful finding: the UI is already almost free of direct public blob URLs. Only
`templates/detail.html:22` (`pet.headshot_url`) still points at the blob endpoint
directly -- every other image goes through the app's `/img` proxy. So *if* Option
A (managed identity) is chosen, a later hardening pass is genuinely small: switch
reads to the same credential, fix that one template line, then set the container
private. Worth knowing, but **out of scope for this change** -- do not do it in
the same pass.

### 6.2 CORS is not needed

Uploads go browser -> Flask app -> blob. No browser-to-blob request, so no CORS
rules on the storage account. Skip that work.

### 6.3 Request size / timeout

Pixel photos are roughly 3-5 MB each. Please verify the platform's max request
body size and gunicorn timeout on these Linux App Service instances and raise
them if needed. The one-photo-per-request design in §3 is specifically to keep
this from becoming a problem.

### 6.4 Pixel filename timestamps are UTC

Pixel writes the `PXL_YYYYMMDD_HHMMSS` filename in UTC, so a photo taken late in
the evening on the last day of a month can carry the next month's date. Harmless
at month granularity, and preferring EXIF `DateTimeOriginal` avoids it entirely.

### 6.5 HEIC

`IMAGE_EXTS` (`app.py:22`) does not include `.heic`. Pixel shoots JPEG by
default, but if she ever enables HEIF the uploader must convert on ingest, which
would need `pillow-heif`. Flagging only; no action now.

### 6.6 Rejected alternatives (do not revisit)

- Azure Storage Explorer -- desktop only, no Android build.
- Azure mobile app -- cannot upload blobs.
- FolderSync -- its provider list has no Azure Blob support (verified against
  their documentation).
- Power Automate -- Azure Blob Storage is a premium connector and the rename
  logic is painful to express in a flow.

---

## 7. What to send back

1. Decision on §4 (storage credential) and confirmation the Azure changes are done.
2. Decision on §5 (user auth), including the tenant-account answer for his wife,
   and whether `/upload` alone or the whole site should be gated.
3. Any app settings you created, by **name only** -- the remote session reads
   them from the environment and must never have the values.

The remote session then implements on
`claude/pet-photos-blob-storage-pixel-z46z0f` and ships to staging first, so she
can test on her Pixel against `staging-pets.stapleton-family.net` before it
reaches production.
