# cookbook — Technical design

> Companion to [`DESIGN.md`](./DESIGN.md) (product) and [`UI.md`](./UI.md)
> (screens). This doc is what an engineer needs to start scaffolding the
> app: stack, topology, data model, auth, search, integrations, testing,
> local dev, deploy.
>
> This is a living document. When something here gets contradicted by
> implementation, fix the doc.

---

## 1. Stack at a glance

| Concern              | Choice                                                                 |
| -------------------- | ---------------------------------------------------------------------- |
| Framework            | **React Router v7** (Remix successor), TypeScript, SSR                 |
| Hosting              | **Netlify** (`@netlify/vite-plugin-react-router`)                      |
| Styling / components | **Mantine** (component library + hooks: `@mantine/core`, `@mantine/form`, `@mantine/notifications`, `@mantine/dropzone`); drag-and-drop via `@hello-pangea/dnd` |
| Database             | **Neon Postgres** (Netlify DB) in production; **Testcontainers** (`pgvector/pgvector:pg16`) in tests. Pinned to Postgres 16. |
| ORM / migrations     | **Drizzle ORM** + `drizzle-kit`                                        |
| DB driver            | **`pg`** (standard node-postgres). *Not* `@neondatabase/serverless`    |
| Auth                 | Hand-rolled: argon2id passwords, signed cookie sessions, invite tokens |
| Image storage        | **Netlify Blobs**                                                      |
| Search               | Postgres FTS (`tsvector` + weights) + `pg_trgm` for fuzzy              |
| Bring! integration   | Server-rendered routes emitting schema.org Recipe JSON-LD              |
| Tests                | **Playwright** end-to-end (only — no unit tests in v1)                 |
| Test runtime         | **Testcontainers** launches Postgres in Playwright `globalSetup`; the test process owns the DB lifecycle. No `docker-compose.yml`. |
| CI                   | GitHub Actions: `lint` (eslint + `tsc --noEmit`) + Playwright on every PR |
| Package manager      | **npm**                                                                |
| Repo layout          | Single React Router app — no monorepo, no separate API                 |

---

## 2. Topology

```
            ┌──────────────────────────────────────────────────────────┐
            │                       Netlify                            │
            │                                                          │
   browser ─┼──▶  CDN / edge  ──▶  Netlify Function (React Router SSR) │
            │                                │                         │
            │                                │ pg over TLS             │
            │                                ▼                         │
            │                    ┌─────────────────────┐               │
            │                    │  Neon Postgres      │               │
            │                    │  (Netlify DB)       │               │
            │                    └─────────────────────┘               │
            │                                                          │
            │     Netlify Blobs ◀── photo upload / serve  ─────────────┤
            │                                                          │
            └──────────────────────────────────────────────────────────┘
```

- **All app code runs in one place:** the React Router server bundle
  hosted as a Netlify Function (Node 22 runtime). No separate API
  service, no Edge Functions, no client-only routes that bypass the
  server. Edge Functions were considered and rejected: they'd run far
  from the DB region (cross-region latency on every query), can't use
  the standard `pg` driver, and can't run argon2id natively. Functions
  pinned to the DB region win on the metric that actually matters.
- **Loaders** (data fetching, GET) and **actions** (mutations, POST)
  live next to their routes (`app/routes/*.tsx`). Both run server-side
  and have direct access to Drizzle + the session.
- **Browser** does the usual React Router hydration; mutations go via
  `<Form>` and `useFetcher` so the same action code serves
  no-JS, JS-on, and progressive-enhancement cases identically.
- **Per-recipe Bring! pages** (`/r/:id`) and the **handoff page**
  (`/h/:flatId`) are public routes. Everything else is gated by the
  session middleware.

---

## 3. Data model

All tables live in one Postgres schema (`public`). IDs are UUIDv7
(time-ordered, generated via `gen_random_uuid()` from `pgcrypto` for v1
— we'll switch to UUIDv7 once Postgres 17 ships it natively or we add
the function).

### 3.1 Identity & flat membership

```
users
  id              uuid pk
  email           citext unique not null
  password_hash   text not null              -- argon2id
  display_name    text not null
  created_at      timestamptz default now()

flats
  id              uuid pk
  name            text not null
  created_at      timestamptz default now()

flat_members
  flat_id         uuid fk → flats(id) on delete cascade
  user_id         uuid fk → users(id) on delete cascade
  joined_at       timestamptz default now()
  primary key (flat_id, user_id)
  -- v1: a user belongs to exactly one flat. Enforced by a partial
  -- unique index on (user_id) so app code can rely on it.

sessions
  id              text pk                    -- random 32-byte token, base64url
  user_id         uuid fk → users(id) on delete cascade
  created_at      timestamptz default now()
  -- v1 has no server-side expiry; sessions persist until logout or
  -- password change. Easy to add an expires_at column later.

invites
  token           text pk                    -- random 16-byte, base64url
  flat_id         uuid fk → flats(id) on delete cascade
  created_by      uuid fk → users(id)
  used_by         uuid fk → users(id)        -- nullable until redeemed
  used_at         timestamptz                -- nullable until redeemed
  expires_at      timestamptz                -- nullable; v1 leaves null
  created_at      timestamptz default now()
```

> **One-flat-per-user** (DESIGN.md §5) is enforced via
> `create unique index flat_members_one_per_user on flat_members(user_id)`.
> Removing it is a v2 schema change, not a code change.

### 3.2 Recipes

```
recipes
  id                  uuid pk
  flat_id             uuid fk → flats(id) on delete cascade
  name                text not null
  base_quantity       integer not null      -- in portions; the unit is fixed
  source_url          text                   -- nullable
  source_host         text                   -- denormalised, computed in app
  photo_blob_key      text                   -- nullable; key into Netlify Blobs
  steps               text not null default ''-- single multiline blob (UI.md §4)
  search_vector       tsvector               -- maintained by trigger (see §5)
  created_at          timestamptz default now()
  updated_at          timestamptz default now()

ingredients
  id          uuid pk
  recipe_id   uuid fk → recipes(id) on delete cascade
  position    integer not null               -- 0-based, stable order
  amount      numeric                        -- nullable for "salt to taste"
  unit        text                           -- nullable
  item        text not null
  unique (recipe_id, position)
```

Indexes:
- `recipes(flat_id)`
- `gin (recipes.search_vector)` for FTS
- `gin (recipes.name gin_trgm_ops)` and `gin (ingredients.item gin_trgm_ops)` for fuzzy

### 3.3 Recipe instances and finalised lists

A recipe-instance has a single lifecycle — added to the draft,
finalised into the list, then cooked off the in-stock board — so we
model it as a single table whose row progresses through states.
State is **derived from which timestamps are populated**, not stored
as an enum, which avoids any drift between status and timestamps:

| state    | predicate                                          |
|----------|----------------------------------------------------|
| draft    | `finalised_at IS NULL`                             |
| in stock | `finalised_at IS NOT NULL AND cooked_at IS NULL`   |
| cooked   | `cooked_at IS NOT NULL`                            |

```
recipe_instances
  id                    uuid pk
  flat_id               uuid fk → flats(id) on delete cascade
  recipe_id             uuid fk → recipes(id) on delete restrict
  target_quantity       integer not null
  designated_cook_id    uuid fk → users(id)         -- nullable
  position              integer not null            -- user-orderable while draft & in-stock; preserved into cooked
  added_at              timestamptz default now()
  finalised_at          timestamptz                 -- draft → in stock
  cooked_at             timestamptz                 -- in stock → cooked
  cooked_by             uuid fk → users(id)         -- nullable
  note                  text                        -- nullable; short kitchen-only annotation ("cook this on Friday"); editable in draft + in-stock; never exposed on public /h/:flatId
  check (cooked_at is null or finalised_at is not null)

-- Partial unique indexes keep position unique per "lane":
create unique index on recipe_instances(flat_id, position)
  where finalised_at is null;
create unique index on recipe_instances(flat_id, position)
  where finalised_at is not null and cooked_at is null;

-- Read-side indexes for the three lanes:
create index on recipe_instances(flat_id) where finalised_at is null;
create index on recipe_instances(flat_id) where finalised_at is not null and cooked_at is null;
create index on recipe_instances(flat_id, cooked_at desc) where cooked_at is not null;
```

There is **no separate `shopping_lists` table**. The handoff URL
(§6.2) is `/h/<flat_id>` — public, non-auth, non-rotatable. The
flat's UUID doubles as the public read-token. Trade-off captured in
§13.

Notes:

- **No snapshot needed.** The handoff page (§6.2) just queries the
  current in-stock lane for the flat. If you remove a stock entry
  before going shopping, it disappears from the handoff URL too —
  desired ("changed my mind, drop it"). After shopping, you'd
  rarely revisit the URL.
- **Position renumbers on finalise.** Draft positions don't necessarily
  match in-stock positions (the partial unique indexes are independent),
  so finalise appends each draft row after the current in-stock max,
  preserving draft order. Once in the in-stock lane the user can
  re-drag them to a cook order.
- **`recipe_id ON DELETE RESTRICT`**: deleting a recipe that has any
  live or historical instances must be an explicit decision (the
  UI's `…` "Delete recipe" surface warns). Cooked rows are an
  immutable log; we don't want a delete-recipe to silently rewrite
  history.
- **Adding a status later** (e.g. "discarded without cooking") is a
  one-column nullable-timestamp migration plus an updated check
  constraint — no enum to extend.

---

## 4. Auth

Hand-rolled, deliberately small. Three tables (`users`, `sessions`,
`invites`) and four routes.

### 4.1 Password hashing

- **Algorithm:** argon2id, via the `argon2` npm package.
- **Parameters:** `memoryCost: 19 MiB, timeCost: 2, parallelism: 1`
  (OWASP 2024 baseline for argon2id). Tuneable via env in case Netlify
  Functions' memory budget gets tight.
- **Comparison** uses the library's verify (constant-time).

### 4.2 Sessions

- **Token:** 32 random bytes, base64url. Stored as the `sessions.id`.
- **Cookie:** `cb_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000` (1 year — long-lived so browsers persist it across restarts).
- **Cookie value is signed** with HMAC-SHA256 using `SESSION_SECRET`
  (env). Signing prevents accidental tampering even though the token
  itself isn't a secret.
- **No server-side expiry in v1.** A session row exists until logout
  or password change. We accept the trade-off (stolen cookies stay
  valid until the user notices and logs out / rotates their password)
  and revisit if/when the app leaves the flat. Adding an `expires_at`
  later is a one-column migration plus a `where expires_at > now()`
  in the lookup.
- **Lookup:** every authenticated loader/action calls
  `requireFlatMember(request)`, which:
  1. Reads + verifies the cookie.
  2. Looks up the `sessions` row.
  3. Joins to `users` and `flat_members` (single query); attaches
     `{ user, flat }` to the request context.
  4. Throws a `redirect("/login")` (loader) or 401 (action) if any
     check fails.
- **Logout:** deletes the row, clears the cookie.
- **Rotation:** on password change, every `sessions` row for that
  user is deleted. That's our "log out other devices" lever.

### 4.3 Invite flow

- An existing flat member POSTs `/flat/invite` → server inserts an
  `invites` row, returns the URL: `/invite/:token`.
- A new user opens `/invite/:token`:
  - If logged in: refuse (we don't transfer flats in v1).
  - If logged out: render a "create account to join *Wohnung 3*" form
    (email, display name, password).
  - On submit: validate token unused + not expired, create user,
    create `flat_members` row, mark invite used, log the user in.
- "Generate new link" rotates: marks the previous invite expired (or
  just leaves it; the UI surfaces only the latest token).

### 4.4 Boring / dangerous bits we own

- **Timing-safe email lookup:** always run argon2 verify even if the
  user doesn't exist (against a fixed dummy hash) so the response time
  doesn't reveal account existence.
- **CSRF:** React Router's `<Form>` posts are same-origin and
  cookie-authenticated. We add a per-session CSRF token, included as
  a hidden field by a small `<CsrfField/>` helper, validated in a
  shared `requireFlatMember` action wrapper. `SameSite=Lax` is the
  baseline; CSRF token is the belt for non-GET requests.
- **Cookie rotation:** session IDs are rotated on password change
  (every row for that user is deleted; the user re-logs in) and on
  invite redemption.
- **Password rules:** min 12 chars, no max; no composition rules
  (NIST 800-63B). Block the most common ~10k passwords via a small
  embedded list.

---

## 5. Search

Per DESIGN.md §4.1, search is first-class: instant, typo-tolerant,
weighted across name / ingredients / source URL host / steps, with
highlighted matches.

### 5.1 Index

```sql
-- maintained by trigger on insert/update of recipes & ingredients
recipes.search_vector :=
    setweight(to_tsvector('simple', unaccent(coalesce(name, ''))), 'A')
  ||setweight(to_tsvector('simple', unaccent(string_agg(ingredients.item, ' '))), 'B')
  ||setweight(to_tsvector('simple', unaccent(coalesce(source_host, ''))), 'C')
  ||setweight(to_tsvector('simple', unaccent(coalesce(steps, ''))), 'D');

create index recipes_fts on recipes using gin (search_vector);
create index recipes_name_trgm on recipes using gin (name gin_trgm_ops);
create index ingredients_item_trgm on ingredients using gin (item gin_trgm_ops);
```

- Configuration is `simple` (no language stemming) so that
  cross-language collections (German + English ingredient names) work
  uniformly. Stemming is a v2 if we feel we need it.
- `unaccent` flattens `Hähnchen` → `hahnchen` so users don't need to
  type umlauts.

### 5.2 Query path

For a user query `q`:

1. Build a `tsquery` by tokenising `q` on whitespace, AND-ing terms,
   each with `:*` (prefix match). E.g. `chicken miso` → `chicken:* &
   miso:*`.
2. Run a `SELECT … WHERE search_vector @@ ts_query OR EXISTS (… trigram fallback …)`
   ranked by `ts_rank_cd(search_vector, ts_query)` descending.
3. Trigram fallback (`%` similarity) only kicks in when the FTS
   result set is small (< N rows), to absorb typos like
   `tomat` → `tomato`. Threshold ≥ 0.3 (default `pg_trgm`).
4. The query builder is a small pure function (`buildSearchSql(q)`) →
   covered by Playwright unit tests.

### 5.3 Highlighting

`ts_headline(name, ts_query, 'StartSel=«,StopSel=»,MaxFragments=1')` for
the name, plus per-ingredient highlight when an ingredient matched.
Renderer turns `«…»` into `<mark>` spans.

---

## 6. Bring! integration

Two route families:

### 6.1 Per-recipe page — `/r/:recipeId`

Public, no auth. Renders the recipe with `<script type="application/ld+json">`
embedded, shape:

```json
{
  "@context": "https://schema.org/",
  "@type": "Recipe",
  "name": "Pasta al limone",
  "recipeYield": "4 servings",
  "recipeIngredient": [
    "400 g spaghetti",
    "2 lemons",
    "100 g parmesan",
    "1 bunch parsley"
  ],
  "recipeInstructions": "1. Boil salted water…\n2. …",
  "image": "https://…/blobs/<key>"
}
```

- Optional `?q=<integer>` query param scales the recipe to that target
  quantity before emitting the JSON-LD. Missing → base quantity.
- Rendered HTML is intentionally minimal but human-readable; that's
  what scrapers see and what users see if they tap the link directly.

### 6.2 Handoff page — `/h/:flatId`

Public, no auth. The flat's UUID doubles as the public read-token —
unguessable in practice, never rotated (see §3.3 and §13 trade-off).
Reads the current in-stock lane:

```sql
SELECT * FROM recipe_instances
 WHERE flat_id = $flat_id
   AND finalised_at IS NOT NULL
   AND cooked_at IS NULL
 ORDER BY position;
```

Renders:

- **Desktop:** "send this to your phone" card (QR + Copy) with the
  current page URL.
- **Mobile:** the per-recipe `Share into Bring! →` list. Each share
  target's payload is the per-recipe URL from §6.1, scaled.

UI per UI.md §8. Same URL, two responsive renderings.

The URL is stable for the life of the flat — bookmarkable on the
phone as "our shopping list lives here". It always shows whatever
is currently in-stock; there is no per-finalise URL.

### 6.3 Combined shopping list (embedding dedup)

Snapshot lifecycle:

1. **Finalise** (see §7) commits the in-stock transition. Right
   after, in the same handler (outside the transaction, best-effort),
   we build a structured input of every in-stock ingredient
   (`{id, amount, unit, item, recipe}`, scaled to the target
   quantity) and call the dedup backend.
2. The backend **embeds** each ingredient's `item` text (via Google's
   native Gemini embedding API — `SEMANTIC_SIMILARITY` task, 1024 dims)
   and clusters the items by cosine
   similarity: a single-linkage / union-find pass over the items,
   grouping any pair at or above `DEDUP_SIMILARITY_THRESHOLD` into a
   connected component. Only groupings come out —
   `{ merges: [{ ids: ["i1", "i2"] }, …] }` — no amounts, no units,
   no display text. Anything not clustered with anything else stays a
   singleton.
3. The server post-processes via `app/lib/units.ts`: drops
   unit-incompatible suggestions (families never cross — see below),
   sums amounts in a canonical base unit, picks a readable display
   unit, picks the display item name deterministically
   (most-frequent → shortest), and composes `displayText` via the
   existing `formatIngredient` helper. The resulting `DedupGroup[]`
   is persisted on the `flats` row along with the input hash,
   generation time, and model name (`embedding:<model>`).
4. If the embeddings call or validation fails, we write a no-merge
   snapshot — Finalise never fails because the model is down.

**Unit families** (compatibility buckets for summing):

| Family | Base | Convertible units |
|--------|------|-------------------|
| `mass` | g | g/gram(s), kg, mg, oz, lb/pound(s) |
| `volume` | ml | ml, cl, dl, l/liter(s)/litre(s), cup(s) (US **240 ml**), pint/quart/gallon; DE tasse |
| `tsp_tbsp` | tsp | tsp/teaspoon(s), tbsp/tablespoon(s); DE tl/el |
| `q:<key>` | 1 | qualitative exact-match after synonym fold (pinch, dash, clove, …) |
| `count` | 1 | empty / null unit |
| `u:<key>` | 1 | any unrecognized unit string |

Mass and volume never cross (so `200 g flour` + `2 cups flour` stay
separate). Synonyms and plurals are normalized before lookup
(`cups`→`cup`, `grams`→`g`). After summing, display prefers a
readable unit (e.g. `1500 g` → `1.5 kg`, `48 tsp` → `16 tbsp`;
cup+ml mixtures display in ml). Logic is covered by
`tests/units.spec.ts` plus E2E in `tests/handoff-dedup.spec.ts`.

Embeddings are cached in the `ingredient_embeddings` table, keyed by
`(model, text)` where `text` is a normalized form of the item string
(Unicode NFC, whitespace collapsed, lowercased). Normalizing the cache
key means case/whitespace variants ("Rote Linsen" / "rote Linsen") share
one vector and always cluster, independent of the threshold — and it can
only ever merge trivially-different texts, never distinct ingredients.
Each finalise reads the cache first and only requests vectors for the
misses (batched, chunked ≤96/call for Gemini, ≤512 for OpenAI), then
`insert … on conflict do
nothing`. The cache is shared across recipes and flats, so repeat
ingredients and regenerates avoid re-paying. The `embedding` column is a
native pgvector `vector` with **no fixed dimension**, so switching
`DEDUP_EMBEDDING_MODEL` (which changes the vector length) needs no
migration — clustering is done in JS, so no ANN index (which would
require a fixed dimension) is needed.

The handoff loader reads the snapshot. If the current in-stock
input hash diverges from the stored one (recipes edited after
Finalise), the page renders an all-singletons fallback and shows a
**Regenerate** button. Per-merge **Split** / **Undo split** flip a
group id in `flats.dedup_rejected_group_ids`; rejected groups expand
back into source lines in both the visible list and the JSON-LD.

**List order differs by surface.** Handoff sorts **merged groups
first** (then stable within each tier) so near-dup wins stay at the
top for Split/override. The kitchen **Planned ingredients** view
(`loadCombinedList`, all currently in-stock recipes) sorts **A–Z by
representative `item` name** instead — merged and singleton rows
interleave — because that surface is read-only and meant for scanning.
On mobile (`/kitchen?lane=ingredients`) a tucked-away client filter
(icon → expands left over the heading on the same row) matches against
item / display text / source recipe names; the desktop sidebar modal
has no filter (browser find is enough).

Writes (`split`, `unsplit`, `regenerate`) are public and keyed on
the flat UUID, consistent with the rest of the handoff page's
trust model.

Config: `DEDUP_EMBEDDING_MODEL` overrides the embedding model
(default `gemini-embedding-001`) and `DEDUP_SIMILARITY_THRESHOLD`
tunes the cosine cutoff (default `0.95`). The provider is chosen by
model id: any `gemini-*` model uses Google's **native**
`batchEmbedContents` API (auth via `x-goog-api-key` =
`EMBEDDING_GEMINI_API_KEY`, falling back to `GEMINI_API_KEY`; base URL
`EMBEDDING_GEMINI_BASE_URL`, default
`https://generativelanguage.googleapis.com/v1beta`). Any other model id
falls back to the OpenAI-compatible path, **pinned directly to OpenAI** —
the client is constructed with `baseURL` = `EMBEDDING_OPENAI_BASE_URL`
(default `https://api.openai.com/v1`) and `apiKey` =
`EMBEDDING_OPENAI_API_KEY`. That pinning is deliberate: in prod Netlify
injects `OPENAI_BASE_URL` pointing at the Netlify AI Gateway, which
serves *chat* models only — routing `text-embedding-*` there returns
`400 unable to find suitable provider`.

We switched the default from OpenAI `text-embedding-3-small` (@0.82) to
Gemini after an offline eval (`ml/embedding-eval/`) on a gold set derived
from real prod ingredient texts: Gemini clearly won for German/English
shopping-list dedup, separating true synonyms and cross-lingual pairs
(Möhren/Karotten, Parmesan/Parmigiano, Knoblauch/garlic) that
`text-embedding-3-small` collapsed, and more than doubling recall at zero
false merges. Gemini runs "hot" (high cosine even for unrelated pairs),
which is why its threshold (`0.95`) sits well above the old OpenAI value
(`0.82`) — the two numbers live on different scales and are not
comparable.

During `npm test` each Playwright worker runs a bespoke HTTPS-MITM
forward proxy (`tests/proxy/`); specs that exercise dedup opt in to the
`mocks` fixture and register a Gemini route via
`mocks.route("https://generativelanguage.googleapis.com/**", geminiEmbeddingHandler())`
(from `tests/mock-handlers.ts`), which returns a deterministic vector
per input string (identical/variant texts embed identically), so
tests never hit the real API.

---

## 7. The Finalise transaction

The single most important state transition in the app
(DESIGN.md §4.3). Wrapped in a transaction because we touch every
draft row and need to renumber positions to dodge the in-stock
partial unique index:

```sql
-- Conceptually:
WITH stock_max AS (
  SELECT coalesce(max(position), -1) AS m
    FROM recipe_instances
   WHERE flat_id = $flat_id
     AND finalised_at IS NOT NULL
     AND cooked_at IS NULL
),
ranked AS (
  SELECT id, row_number() OVER (ORDER BY position) - 1 AS rn
    FROM recipe_instances
   WHERE flat_id = $flat_id
     AND finalised_at IS NULL
)
UPDATE recipe_instances ri
   SET finalised_at = now(),
       position = (SELECT m FROM stock_max) + 1 + r.rn
  FROM ranked r
 WHERE ri.id = r.id
   AND ri.finalised_at IS NULL;
```

Marking a stock entry as cooked is the symmetric one-liner:
`UPDATE recipe_instances SET cooked_at = now(), cooked_by = $user WHERE id = $id`.

- Drizzle implementation iterates draft rows inside
  `db.transaction(...)` rather than emitting the CTE — same effect,
  simpler typing.
- Each per-row `UPDATE` re-asserts `finalised_at IS NULL` so a
  concurrent finaliser's just-finalised rows are skipped instead of
  overwritten.
- The action returns `redirect("/h/" + flat_id)` on success;
  the desktop client opens it as a modal, mobile as a page.
- Concurrency: two members hitting Finalise simultaneously each
  finalise whatever was still in draft when their transaction
  started. The second tx may find an empty draft (no-op) or a
  partial overlap (only the not-yet-finalised rows get touched).
  Either way the final state is "no draft, all rows finalised".

---

## 8. Image upload

- Photo upload is a `multipart/form-data` POST to the recipe
  edit/create action.
- Server validates: MIME in `{image/jpeg, image/png, image/webp}`,
  size ≤ 5 MB, dimensions decoded (rejects malformed).
- Stored in Netlify Blobs under key
  `recipes/<recipe_id>/<random>.<ext>`. Key written to
  `recipes.photo_blob_key`.
- Served via a route `/blobs/recipes/:key` that streams from
  `getStore("recipes").get(...)` with appropriate `Cache-Control`
  (immutable, 1 year — keys are random per upload).
- Locally: emulated via `.netlify/blobs/` (filesystem-backed), no
  cloud calls (see §11).
- No image processing in v1 (no thumbnailing, no EXIF strip beyond
  what the browser does on capture). Track as a v2 if file sizes
  start to bite.

---

## 9. Concurrency / realtime stance

- **Not real-time** in v1. No WebSockets, no SSE, no pushed updates.
- **Stale-while-revalidate via React Router:** any action causes its
  loader (and any loader explicitly listed via `shouldRevalidate`) to
  re-run, so the UI is fresh immediately after your own edits.
- **Concurrent edits are last-writer-wins.** Two flat members
  changing the same draft entry's target quantity at the same time
  → the later POST wins. We accept this for v1 (one flat = a few
  people, low collision rate).
- **Add-to-draft is non-conflicting** — each add is an INSERT with a
  monotonically increasing `position`, computed in the action via
  `select coalesce(max(position), -1) + 1`. Two simultaneous adds may
  briefly contend; we accept the rare double-position by using a
  `unique (flat_id, position)` constraint and retrying once on
  conflict.

---

## 10. Testing

Playwright is the only test framework, and we only write **end-to-end
tests** in v1. Pure-function logic (scaling math, ingredient dedupe,
search-query building) is exercised through the E2E flows that depend
on it — if scaling were wrong, the "scale a recipe in the draft"
spec would fail. Adding unit tests later is cheap; we defer until a
specific bug genuinely needs the smaller scope.

### 10.1 Real app, real Postgres, real session cookies

The test process owns the database lifecycle end-to-end:

- **Postgres** is launched by Playwright `globalSetup`
  (`tests/global-setup.ts`) via Testcontainers
  (`@testcontainers/postgresql`, image pinned to `pgvector/pgvector:pg16`
  — stock `postgres:16` plus the pgvector extension).
  No `docker-compose.yml`, no orchestration script,
  no `.env.development`. The container's connection string is
  written into `process.env.DATABASE_URL` so worker fixtures
  inherit it when spawning the app server.
- **Schema** is applied with `drizzle-kit push` immediately after
  the container is ready.
- **App** runs as a **production build** served by
  `react-router-serve`, spawned **per Playwright worker** by the
  `server` fixture (`tests/fixtures.ts`). Each worker also gets its
  own Netlify Blobs emulator (`BlobsServer`) so photo/avatar uploads
  work without `netlify dev`. The fixture parses the
  `[react-router-serve] http://…` ready line for that worker's
  `baseURL`. Production deploy still goes through `netlify.toml` +
  `@netlify/vite-plugin-react-router`.
- Locally, `TESTCONTAINERS_REUSE_ENABLE=true` is honoured for fast
  iteration; CI always cold-starts.

### 10.2 No test-only code in the app

The app itself has zero awareness that it's running under tests.
Specifically:

- **No `/_test/*` routes**, no test-only endpoints, no `loginAs`
  shortcut, no `mintSession` import.
- **No `storageState`** machinery. Every spec starts unauthenticated.
- Tests act like real users. The `tests/login.ts` helper is a thin
  convenience that fills the real form:

  ```ts
  await page.goto('/login');
  await page.fill('[name=email]', email);
  await page.fill('[name=password]', password);
  await page.click('button[type=submit]');
  await page.waitForURL('/');
  ```

  It does exactly what a user would. `tests/login.spec.ts` doesn't
  use it — it tests the form directly.
- Test-only setup that *can't* be done through the UI (DB reset,
  bulk seeding) goes through **direct Drizzle access** from the test
  process. The test process imports `app/db/schema.ts` and opens its
  own `pg` pool. This keeps production builds free of any test
  shape.

### 10.3 Fixtures

Two Playwright fixtures live in `tests/fixtures.ts`:

- **`tenant` (opt-in)** — runs when a spec asks for it via
  `({ tenant }) => …`. Calls `createTenant()` (in `tests/tenant.ts`),
  which inserts a fresh user (`test-<uuid>@cookbook.test` / password
  `cookbook`) + a fresh flat + the membership row, and returns
  `{ user, flat }`. The argon2 hash for the shared test password is
  computed once at module load and reused across all tenants.
- **`seed(payload)`** — typed Drizzle inserts for additional
  recipes, ingredients, and recipe_instances scoped to a tenant.
  Returns IDs the spec can use. (Added as needed in later phases.)

We rely on **multi-tenancy** for test isolation rather than a global
TRUNCATE: each test gets its own user + flat, so tests can't see
each other's data through the app. No reset step is needed.

`fullyParallel: true` from the start — per-test tenants remove the
only source of shared mutable state, so parallelism is safe by
construction. Playwright picks the worker count automatically.

### 10.4 Coverage targets for v1

- Login + invite redemption (happy path, used token, wrong password)
- Recipe CRUD (create, edit, photo upload, delete with live state warning)
- Search (name match, ingredient match, typo via trigram, weighting order, highlight)
- Drafting (add to draft, scale target quantity, assign cook, remove)
- Finalise → handoff (single UPDATE succeeds, handoff URL renders both views, JSON-LD scales with `?q`)
- Mark cooked (recipe_instance gets `cooked_at`; in-stock view no longer shows it)
- Multi-user: two browser contexts in the same flat, edits visible after refresh

### 10.5 CI

GitHub Actions workflow on every PR:

1. Checkout, Node 22, `npm ci`
2. `npm run lint` (eslint + `tsc --noEmit`)
3. `npx playwright install --with-deps chromium`
4. `npm test` — Playwright `globalSetup` boots Postgres via
   Testcontainers inside the runner and runs the suite against it.

No Postgres `services:` block in the workflow — Testcontainers
handles it. The runner needs a Docker daemon, which GitHub-hosted
Linux runners ship with.

---

## 11. Local development = the E2E loop

> **There is no `npm run dev` in v1.** The primary developer
> interaction with the app is writing and running Playwright tests.
> The test rig already boots the app, the database, and seeds
> realistic state — that's the inner loop.

```bash
git clone …
npm install
npm test
```

That's it. `npm test` is `playwright test`, which:

1. Runs `tests/global-setup.ts` — boots a `pgvector/pgvector:pg16`
   container via Testcontainers, applies the schema with
   `drizzle-kit push`, exports `DATABASE_URL`.
2. Starts a `react-router-serve` of the production build per
   Playwright worker via the `server` worker fixture
   (`tests/fixtures.ts`), plus a per-worker Netlify Blobs emulator
   and an HTTPS-MITM forward proxy. Specs configure mocks on-demand
   through the opt-in `mocks` test fixture using
   `mocks.route(pattern, handler)` and the factories in
   `tests/mock-handlers.ts`.
3. Runs the suite. Each test that asks for a tenant gets a fresh
   user/flat via the `tenant` fixture (§10.3) and logs in via the
   real form using the `login()` helper.
4. No teardown — the `pgvector/pgvector:pg16` container is started with
   `withReuse()`, so it survives across `playwright test` invocations
   on a developer machine for fast iteration. CI cold-starts each
   run.

Local Postgres ↔ production parity is enforced the same way it is
in CI (§11.2): same `pg` driver, same extensions, pinned major.

### 11.1 Visual exploration

When you want to *see* the app rather than just run specs:

| Need                                       | Use                          |
| ------------------------------------------ | ---------------------------- |
| Step through a single spec interactively   | `npx playwright test --debug some.spec.ts` |
| Time-travel any past test run              | `npx playwright test --ui`   |
| Pause mid-spec, click around the live app  | `await page.pause()` in the spec — Playwright opens an inspector and the app + container stay alive until you resume |
| Run with a visible browser                 | `npx playwright test --headed` |

This covers every reason you'd previously want a "dev mode": the
app is running, the DB has whatever the spec seeded, you can poke
at the UI freely. No second context to spin up.

### 11.2 Local Postgres ↔ Neon parity

Designed in, not hoped for:

- **Pinned major version.** Testcontainers uses `pgvector/pgvector:pg16`
  (stock Postgres 16 plus pgvector) to match Neon's default major.
  Bumped in lockstep.
- **Standard `pg` driver everywhere.** Not
  `@neondatabase/serverless`. The standard driver works against both
  raw Postgres and Neon's PgBouncer-backed pooler URL — keeps code
  portable and avoids serverless-driver-only behaviour.
- **Only Neon-supported extensions in v1:** `pg_trgm`, `unaccent`,
  `pgcrypto`, `vector` (pgvector, for embedding dedup — §6.3).
  Built-in FTS (`tsvector`/`tsquery`) is core Postgres,
  identical on both. Any new extension is gated on Neon's supported
  list.
- **Real safety net (Phase 6):** add a CI job that runs the
  Playwright suite against an ephemeral Neon branch per PR (Neon
  branching API). Drift between local Postgres and real Neon shows
  up there before it hits main. Until that lands, the
  Testcontainers run is the only safety net.
- **Known divergences we accept:**
  - Neon's auto-suspend / cold starts (perf, not correctness).
  - PgBouncer transaction-pooling has session-state caveats — we
    avoid relying on cross-request session state anyway.

### 11.3 npm scripts

Only four:

| Script              | What it does                                            |
| ------------------- | ------------------------------------------------------- |
| `npm test`          | The whole loop — Playwright + Testcontainers + app.     |
| `npm run db:generate` | Drizzle: diff schema → SQL migration file in `drizzle/`. |
| `npm run lint`      | eslint + `tsc --noEmit`.                                |
| `npm run build`     | Production build (used by Netlify).                     |

No `db:push` (globalSetup applies the schema), no `db:reset`
(per-test tenants make a global reset unnecessary), no `dev:*` (no
dev mode), no separate `typecheck` (folded into `lint`).

For Playwright variants (`--debug`, `--ui`, `--headed`), invoke the
CLI directly — see §11.1.

### 11.4 What needs internet / Netlify auth

- `npm install` (the registry) and `git push` → Netlify deploy.
  That's it.
- Local runs need a working **Docker daemon** (Testcontainers
  requirement). That's the only system dependency beyond Node.
- Optional: `netlify link` + `netlify env:pull` to sync env vars
  from the deployed site, or `netlify deploy --build` for a manual
  deploy. Neither is required for normal feature work.

---

## 12. Deployment

- Netlify site connected to the GitHub repo. Production branch:
  `main`. Preview deploys per PR.
- **Build:** `npm run build` (React Router → `build/` server bundle +
  `build/client/` assets). The `@netlify/vite-plugin-react-router`
  Netlify plugin wraps the server bundle as a Function automatically.
- **Migrations:** the Netlify build command applies pending Drizzle
  migrations against `$DATABASE_URL` before building:
  `npx drizzle-kit migrate && npm run build`. Roll-forward only —
  schema changes are reviewed for backwards compat in PR. (No `db:migrate`
  npm script — we keep the four-script rule from §11.3.)
- **Env vars** (set in Netlify UI):
  - `DATABASE_URL` — Neon pooled connection string
  - `SESSION_SECRET` — 32-byte random, rotated by force-logout
  - `BLOBS_*` — provided automatically by Netlify
- **Preview deploys** per PR point at the production DB read replica
  for v1 — we'll reconsider once we have data worth corrupting.
  (Phase 6 adds an ephemeral Neon branch per PR for the Playwright
  parity run; that branch is *not* what preview deploys connect to.)

---

## 13. Open questions / deferred to v2

- **Neon-branch-per-PR parity run.** v1 CI runs the Playwright
  suite against Testcontainers Postgres only (§10.5). Phase 6 adds
  a second CI job that creates an ephemeral Neon branch via the
  Neon API, applies migrations, and runs the suite against it —
  catches any drift between local Postgres and real Neon before it
  hits main.
- **Email sending for invites.** v1: invite link is shown in the UI;
  the inviting member shares it via whatever channel they like. v2:
  add an SMTP provider (Resend / Postmark) and email the link.
- **Observability.** v1: Netlify's built-in logs + Neon's slow query
  log. v2: structured logging (pino) shipped to a sink.
- **Backups.** Neon snapshots are daily by default — sufficient for
  v1. No app-level export yet.
- **Rate limiting beyond login.** Not needed at our scale; revisit
  when we have more users.
- **Pantry-aware shopping list** (subtract what's already in stock).
  Explicit DESIGN.md non-goal — would need a real pantry model.
- **Migration to a search service** (Meilisearch / Typesense) if
  Postgres FTS recall ever feels off. First lever before that:
  loosen `pg_trgm` similarity threshold and add an `unaccent`-aware
  trigram index on `ingredients.item`.
- **Rotatable handoff URL.** v1 uses `flat_id` directly as the
  public handoff token (§3.3, §6.2). It can't be revoked without
  changing the flat's PK. If/when we ever need rotation (flatmate
  leaves, URL leaked, going public-collections / multi-tenant), add
  a `flats.handoff_slug` column (random, regeneratable) and switch
  the route to `/h/<slug>`. One column, no data migration beyond
  backfilling the slug.
- **Public collections** (DESIGN.md §8). Schema already keeps recipes
  separable from flat-internal state, so the v2 path is "add a
  visibility column on `recipes` (or per-flat publish-set) + an
  unauth public route".
