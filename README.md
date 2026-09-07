# AnimalWebsite — The Stapleton Pack

A scroll-driven journey through the life of the family pack, rendered as a
45°-tilted 3D diorama. The trail starts at the union of Belle and Lucy and
walks forward through every season the family has known.

- Production: https://pets.stapleton-family.net (deploys from `main`)
- Staging: https://staging-pets.stapleton-family.net (deploys from `staging`)

## How content works (no deploys needed)

Everything the site shows lives in the Azure Storage container
`animalwebsitestg/pets`. The Flask app discovers it at request time
(cached 60s).

```
pets/
  <slug>/                    ← one folder per pet; the slug is the URL name
    headshot.jpg             ← required; the pet appears once this exists
    meta.json                ← recommended; see fields below
    captions.txt             ← optional; lines of "filename.jpg: a caption"
    gallery/
      2022-06_lakeday.jpg    ← YYYY-MM_ (or YYYY-MM-DD_) prefix places the
      IMG_2044.jpg              photo at that date; no prefix → upload date
```

`meta.json` fields (all optional — sensible fallbacks apply):

```json
{
  "name":   "Matilda",
  "born":   "2021-11",
  "joined": "2022-01",
  "passed": null,
  "color":  "#3F7D77",
  "bio":    "A gentle giant who fell in step beside us."
}
```

- **Hidden memories (easter eggs):** `_trail/lore.json` in the container holds
  a list of `{"date": "2017-05", "item": "tennis-ball", "dog": "lucy",
  "note": "..."}` entries. Items: tennis-ball, slipper, bone, stick, sock,
  bowl, party-hat. Each becomes a small clickable object hidden near the
  trail at that date.
- **Preview lighting:** append `?t=day`, `?t=dusk`, or `?t=night` to the URL
  to preview a time of day; without it the site uses the visitor's local time.
- **New pet:** create the folder with a headshot and meta.json. Done.
- **New photos:** upload to `gallery/` with a date prefix. They join that
  season's camp on the trail automatically.
- **A pet who has passed:** set `"passed": "YYYY-MM"`. The trail shows a
  lantern at that point, and they are remembered at the trail's end.
- The two earliest-joined pets form the union gate where the trail begins.

## Journey model

- Photos are grouped into **season camps** (e.g. "Summer 2022"); the trail
  stays a pleasant length no matter how many photos accumulate.
- The map's ground colors and scenery follow the real seasons of the dates
  passing under the camera.
- `/img?path=...&w=...` is a resize-and-cache proxy so the trail loads small
  images; the lightbox loads larger ones.
- `/api/journey` returns the computed journey model as JSON.
- The ground, trees, rocks, water and mountain backdrop are an illustrated
  ink-and-brush art pack that lives in `static/images/alpine/`, driven by
  `static/images/alpine/manifest.json` (file names, pixel sizes and byte
  budgets for every asset). Until real art lands, that folder holds
  deterministic placeholder art. See `docs/alpine-art-brief.md` for the
  style sheet, palettes and full asset list. Append `?ground=flat` to the
  trail URL to roll the ground back to the pre-art flat gradient look — the
  phone-budget rollback if the painted overlays ever need to come off.
  Finer levers for diagnosis on a phone: `?snow=off`, `?ink=off`,
  `?dirt=off`, `?sprites=off` (vector trees instead of atlas sprites),
  `?water=off` (plain teal creek and pond instead of the water and bank
  tiles), `?motion=off` (no grass sway or creek flow elements), `?look=0`
  (no lookahead band) and `?tile=512` (dirt pattern tile).

## Development

```
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
az login             # blob reads use your own Entra identity locally
python app.py        # http://localhost:8000
```

The container is (or will be) private, so the app authenticates every blob read.
On App Service it uses the web app's managed identity; locally it falls back to
`az account get-access-token`, which needs `az login` and the
`Storage Blob Data Contributor` role on the `pets` container. Without it the
site has nothing to render and says so instead of erroring.

Run the journey locally without Azure credentials by pointing it at a saved
model: `JOURNEY_FIXTURE=tests/fixtures/journey-sample.json python app.py`, then
open `http://localhost:8000`. Photos 404 in fixture mode (there is no blob
storage behind them); that is expected, the fixture exercises the trail's
layout, not the photos. The fixture is ignored, with a logged warning, when the
app detects it is running on App Service, so a leftover setting can never leak
fake data onto the live site.

A Playwright smoke script drives the fixture-mode page through a full-trail
scroll sweep on desktop, lite (touch/iPhone) and reduced-motion profiles and
checks console errors, alive band and surface counts, frame time and long
tasks. First-time setup: `cd tests/smoke && npm install && npx playwright
install chromium`. Then run `node journey-smoke.mjs` from that folder. Add
`--write-baseline` once, after an intentional change to the ground rendering,
to re-record `tests/smoke/baseline.json`. It also runs a fixture with twice
the trail length to confirm alive bands never grow with trail length.

`tests/smoke/webkit-gpu-memory.mjs` measures the GPU-process memory of
Playwright's WebKit (Safari's engine) for URL variants at iPhone size, the
best desktop proxy for the phone's crash ceiling. Run it against a running
fixture server; compare every variant with `?ground=flat`.

Unit tests use plain `unittest`:
`python -m unittest tests/test_fixture_mode.py -v`.

`/upload` is not registered locally unless `UPLOAD_DEV_AUTH=1` is set (and it is
inert on App Service, where Easy Auth is what makes the sign-in headers real).

Deploys: `/deploy-staging` merges the feature branch to `staging`;
`/deploy-prod` (requires `DEPLOY_APPROVED=1`) promotes `staging` to `main`.
See `.claude/project.yaml` for names and URLs.
