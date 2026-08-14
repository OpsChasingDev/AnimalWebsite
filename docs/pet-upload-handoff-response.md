# Response to `pet-upload-handoff.md`

**From:** local session with Azure Global Admin + subscription Owner.
**Date:** 2026-08-14.
**Status:** both decisions made, all Azure changes applied and verified. **No
application code has been written.**

> **Note on audience.** This was written as a reply to the remote session that
> authored `pet-upload-handoff.md`. That session will not be picking the work
> back up. Read this as the standing record of how `/upload` is wired on the
> Azure side — the decisions below are made and live, and whoever implements
> the feature next should build against them.

---

## 1. Decision on §4 — storage credential

**Option A: system-assigned managed identity.** Applied.

The §4 gotcha did not bite: this account is **Owner on the subscription**, so
`Microsoft.Authorization/roleAssignments/write` was already available. No Entra
elevation was needed and none was performed.

| Web app | Principal (object) ID | MI client ID |
| --- | --- | --- |
| `animalwebsite` (prod) | `2daab4df-b7a5-425b-94bd-1456145b2e47` | `685d91b7-d7f2-4139-8913-df498878ee11` |
| `animalwebsite-staging` | `ff345e02-0d02-4054-bf53-de1275088615` | `6d3fbe61-beb1-4b09-bceb-549daff669a0` |

Both identities hold **`Storage Blob Data Contributor`**, scoped to the
**container**, not the account:

```
/subscriptions/61099367-dccb-464a-80c7-497ea6c3b0fd/resourceGroups/animalwebsite_group
  /providers/Microsoft.Storage/storageAccounts/animalwebsitestg
  /blobServices/default/containers/pets
```

So each app can read/write blobs inside `pets` and nothing else — it cannot
create containers or touch other containers in the account.

### Implementation notes for you

Your §4 Option A sketch is correct. Concretely:

```python
# 1. token from the platform-injected endpoint
GET  f"{os.environ['IDENTITY_ENDPOINT']}?resource=https://storage.azure.com/&api-version=2019-08-01"
     X-IDENTITY-HEADER: os.environ['IDENTITY_HEADER']
# -> {"access_token": "...", ...}

# 2. write the blob
PUT  https://animalwebsitestg.blob.core.windows.net/pets/<slug>/gallery/<name>
     Authorization:   Bearer <access_token>
     x-ms-blob-type:  BlockBlob
     x-ms-version:    2021-08-06      # must be >= 2017-11-09 for Entra auth
     Content-Type:    image/jpeg
```

No new dependencies. Matches the existing hand-rolled-`urllib` house style.
**No secret exists anywhere for the storage path** — nothing to rotate.

---

## 2. Decision on §5 — who may reach `/upload`

**Option B: App Service Authentication (Easy Auth) with Entra ID**, on **both**
production and staging.

### The tenant-account question: resolved, and the answer is yes

Robert's wife is **Jordan Stapleton — `jordan@stapleton-family.net`** — and she
**already has a member account in tenant `7a48ae9d-...`**. No B2B guest
invitation was needed, and no Google federation was configured. This is what
made Option B the right call rather than the shared-secret fallback: your §5
recommendation said to prefer B if the tenant question resolved cleanly, and it
did.

Option C (Easy Auth on prod, shared key on staging) was rejected — with a real
account in the tenant, she can sign in to staging just as easily, and C would
have meant a second auth code path plus a secret for no benefit.

### `/upload` only — the rest of the site stays anonymous

To answer your explicit question: **gate `/upload` alone, enforced in app code.**
Easy Auth is configured with:

- `globalValidation.requireAuthentication = false`
- `globalValidation.unauthenticatedClientAction = AllowAnonymous`

so every existing public route is completely unaffected. **Verified after the
change:** `https://pets.stapleton-family.net/` and
`https://staging-pets.stapleton-family.net/` both return `200` anonymously.

**Your side of the contract:** `/upload` and `POST /upload` must check for a
signed-in user themselves. Easy Auth injects these headers on authenticated
requests and **strips any client-supplied copies** when the auth module is
enabled, so they are safe to trust:

```
X-MS-CLIENT-PRINCIPAL-NAME    # e.g. jordan@stapleton-family.net
X-MS-CLIENT-PRINCIPAL-ID
X-MS-CLIENT-PRINCIPAL         # base64 JSON, full claims
```

If the header is absent, redirect to:

```
/.auth/login/aad?post_login_redirect_uri=/upload
```

`/.auth/me` returns the signed-in identity as JSON if you prefer that route.
**Verified:** `/.auth/me` returns `401` anonymously on both apps.

A principal-name allowlist in code is optional defence-in-depth, not required —
Entra already refuses to issue a token to anyone unassigned (below).

### Access is restricted to exactly two people

- App registration: **`AnimalWebsite Upload`**, appId `d85552f6-c8da-4b93-8db7-9ba45132c384`,
  single-tenant (`AzureADMyOrg`).
- Enterprise application: **"Assignment required" = Yes**.
- Assigned users: **Robert Stapleton** and **Jordan Stapleton**. Nobody else.

Anyone else who reaches `/upload` is stopped by Entra at sign-in, before a
request ever arrives at Flask.

All four redirect URIs are registered:

```
https://pets.stapleton-family.net/.auth/login/aad/callback
https://animalwebsite-anbacpdahzg8djgn.eastus2-01.azurewebsites.net/.auth/login/aad/callback
https://staging-pets.stapleton-family.net/.auth/login/aad/callback
https://animalwebsite-staging.azurewebsites.net/.auth/login/aad/callback
```

> **Correction to the handoff.** §5 Option B item 2 lists the prod default
> hostname as `animalwebsite.azurewebsites.net`. That host does not exist. The
> real one is
> `animalwebsite-anbacpdahzg8djgn.eastus2-01.azurewebsites.net`
> (Azure's newer randomised default hostname). The registered URI uses the real
> one. Staging's guess was correct.

### Easy Auth uses no client secret either

Rather than the usual `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET`, Easy Auth is
configured to authenticate **as each web app's own managed identity**, via
workload identity federation. Two federated identity credentials on the app
registration trust the two managed identities:

| FIC name | subject (MI principal ID) |
| --- | --- |
| `mi-animalwebsite-prod` | `2daab4df-b7a5-425b-94bd-1456145b2e47` |
| `mi-animalwebsite-staging` | `ff345e02-0d02-4054-bf53-de1275088615` |

issuer `https://login.microsoftonline.com/7a48ae9d-14ba-4845-b7f8-2cd9387bed48/v2.0`,
audience `api://AzureADTokenExchange`.

**The app registration has zero client secrets and zero certificates.** Nothing
expires, nothing to diarise, nothing to rotate — the same property §4 Option A
gave the storage path now also covers the sign-in path.

**Verified this actually works, not just that it saved:** `/.auth/login/aad`
issues `response_type=code+id_token` on both hosts. That is the *hybrid* flow,
which App Service only uses when it has a working confidential-client
credential; had the federation been misconfigured it would have silently fallen
back to `response_type=id_token` (implicit). Correct `client_id`, tenant, and
redirect URI in both redirects.

---

## 3. App settings created — names only

As requested, **names only. No values are recorded here and none were shared.**

Created on **both** `animalwebsite` and `animalwebsite-staging`:

```
OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID
```

That is the entire list. Its value is the app's own managed identity client ID
(not a secret — it is a public GUID, listed in §1 above).

Pre-existing settings, untouched: `BLOB_BASE_URL`, `SCM_DO_BUILD_DURING_DEPLOYMENT`.

**No `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET` was created**, because of the
secret-free design above. Don't add one — it would override the federation.

---

## 4. Other findings you should know about

### 4.1 Both web apps were stopped

Both `animalwebsite` and `animalwebsite-staging` were in **Stopped** state and
both public URLs returned `403`. This predated my changes. Robert confirmed they
should be running; **both are now started and serving `200`.** Prod took ~17s on
the first hit (cold start), then was fast.

### 4.2 §6.3 — request size and timeout: no change needed

- **gunicorn timeout: 600s.** Neither app sets a custom startup command, so
  App Service's built-in Python container runs
  `gunicorn --bind=0.0.0.0 --timeout 600 app:app`. A 3–5 MB upload is nowhere
  near that.
- Plan is **Basic B2**, comfortably above the Free-tier limits.
- Your one-photo-per-request design keeps bodies at 3–5 MB, well inside App
  Service's request limits. I changed nothing here.

### 4.3 §6.1 respected — anonymous blob access untouched

I did **not** touch `allowBlobPublicAccess` or the `pets` container ACL.
Re-verified after all changes: an unauthenticated
`GET .../pets?restype=container&comp=list` still returns `200`, so
`list_container()` and `_fetch_blob()` keep working. The later hardening pass
you describe is now genuinely available — both apps hold
`Storage Blob Data Contributor` — but it remains out of scope, as you asked.

### 4.4 Recommendation, not applied: Always On

`alwaysOn` is `false` on both apps, which is why prod cold-started in ~17s. Her
first tap on the home-screen icon after an idle period will feel slow. The plan
(Basic B2) supports Always On at no extra cost, since the plan bills regardless.
I left it alone because it wasn't implied by §4 or §5. One command each if
wanted:

```
az webapp config set -g animalwebsite_group -n animalwebsite --always-on true
az webapp config set -g animalwebsite_group -n animalwebsite-staging --always-on true
```

### 4.5 Sign-in frequency

Easy Auth's session cookie is 8 hours by default (72h refresh window). Because
her Entra session persists on the phone, most re-authentications will be a
silent redirect rather than a password prompt — but it will not be *literally*
never, which is a small difference from the Option A bookmark experience
described in §5. If it proves annoying, the cookie expiration is tunable.

---

## 5. State of play

Nothing blocks implementation, and nothing here is provisional — the Azure side
is done and verified. What remains is entirely application code: the six items
listed in §3 of `pet-upload-handoff.md` (the `GET`/`POST /upload` routes,
EXIF-based naming, path construction, the blob write, and the `PXL_`/`IMG_`
date-fallback fix), plus the `/upload` auth check described in §2 above.

Both environments are configured identically, so staging is a true rehearsal for
prod. Ship to `staging` first — Jordan can sign in at
`https://staging-pets.stapleton-family.net/upload` with her normal
`jordan@stapleton-family.net` account.
