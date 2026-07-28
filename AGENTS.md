# AGENTS.md

## Overview

This is **Reactive Resume**, forked and maintained as **"Lazy Media" / `pickit420`** (Docker Hub
image `pickit420/reactive-resume`, GitHub `pickit420/reactive-resume` with `lazy-media/reactive-resume`
as the `upstream` remote). It's a free/open-source, self-hostable resume builder.

It's a **pnpm + Nx monorepo** (not Turborepo) with **three deployable apps** that all get bundled
into **one production Docker image and one Node.js process**:

- `apps/client` — the main React (Vite) app: marketing/home page, auth, dashboard, and the resume
  builder UI. Served at `/`.
- `apps/artboard` — an isolated, headless-friendly React (Vite) app that renders resume templates.
  It has no route for `/` — only `/artboard/builder` and `/artboard/preview` exist. It's consumed
  two ways: embedded in an `<iframe>` by `apps/client` (live preview, public resume pages) via
  `postMessage`, and navigated to directly by a **headless Puppeteer/browserless Chrome instance**
  in `apps/server` to render PDFs and preview screenshots. Served at `/artboard`.
- `apps/server` — a NestJS API. Serves the compiled `apps/client` and `apps/artboard` SPAs as
  static files (`ServeStaticModule`) alongside the `/api/*` REST API, so in production everything
  is one Node process on one port (`PORT`, default 3000).

Backing services (all external, via Docker Compose in real deployments): **PostgreSQL** (via
Prisma ORM), **MinIO/S3-compatible object storage** (avatars, resume PDFs, preview screenshots),
and a **browserless/headless-Chrome container** (PDF generation via Puppeteer, connected to over
a WebSocket — the server does not launch its own local Chrome).

## Codebase map

- `apps/client/src` — `router/` (react-router v6.4+ data router: home, `/auth/*`, `/dashboard/*`,
  `/builder/:id`, and a catch-all `/:username/:slug` public resume route), `pages/` (route
  components, colocated `_components`/`_dialogs`/`_layouts`/`_sections`), `stores/` (zustand:
  `auth`, `resume` — wrapped in `zundo` for undo/redo, `builder`, `dialog`, `openai`), `services/`
  (React Query hooks + axios calls, one folder per domain: `auth`, `resume`, `user`, `storage`,
  `openai`, `feature`, `errors`), `providers/`, `libs/` (axios instance, query client, dayjs,
  lingui setup).
- `apps/artboard/src` — `router/`, `pages/` (`artboard.tsx` shell, `builder.tsx` pan/zoom canvas,
  `preview.tsx` plain stacked-pages renderer used for both the public share page and PDF
  printing), `templates/` (one file per resume template — see below), `components/` (`page.tsx`
  page-sizing primitive, `brand-icon.tsx`, `picture.tsx`), `store/artboard.ts` (single zustand
  store, populated either via `postMessage` from the client iframe or via `localStorage` when
  loaded headlessly by Puppeteer).
- `apps/server/src` — one folder per Nest module: `auth` (local/JWT/refresh/2FA/GitHub/Google/
  OpenID strategies + guards), `user`, `resume` (CRUD + `ResumeGuard` for public/private access),
  `storage` (MinIO client + bucket policy), `printer` (Puppeteer PDF/preview generation —
  `printer.service.ts`), `mail`, `translation` (Crowdin proxy), `feature` (signup/email-auth
  disable flags), `contributors` (GitHub/Crowdin contributor lists), `health` (Terminus checks +
  a `/health/environment` debug endpoint — see Gotchas), `config` (Zod-validated env schema),
  `database` (Prisma module). `main.ts` is the bootstrap (helmet, cookies, CORS, global `api`
  prefix, Swagger at `/api/docs`).
- `libs/schema` — the Zod schema for the resume data model itself (`Resume.data` in Postgres is
  a JSON blob shaped by this). Top level: `{ basics, sections, metadata }`. `sections` has 13
  fixed keys (experience, education, skills, etc.) plus a `custom` record for user-defined
  sections. `metadata.layout` is a `string[][][]` — pages → columns → ordered section keys — and
  is the **only** mechanism for multi-page resumes; there is no automatic/overflow-based
  pagination anywhere in the codebase (see Gotchas).
- `libs/dto` — `nestjs-zod` DTOs (`createZodDto`) that mirror the Prisma models and largely
  compose `libs/schema`. These are the Nest controllers' request/response validation contracts.
- `libs/parser` — import support for four formats: `reactive-resume` (current format,
  passthrough), `reactive-resume-v3` (old format — note: does **not** preserve theme/layout/CSS
  on import, only section items), `json-resume`, and `linkedin` (parses a LinkedIn "Data Export"
  zip via JSZip + PapaParse).
- `libs/ui` — shared shadcn/Radix component library (`libs/ui/src/components`) + `class-variance-
  authority` variants, used by both `apps/client` and `apps/artboard`.
- `libs/hooks` — `use-breakpoint`, `use-form-field`, `use-password-toggle`, `use-theme`.
- `libs/utils` — grouped "namespace" modules: `array`, `color`, `csv`, `date`, `error`
  (`ErrorMessage` enum — the single source of truth for server error codes surfaced to the
  client), `fonts` (large static Google Fonts catalogue), `language`, `number`, `object`, `page`
  (`pageSizeMap` for a4/letter + the shared `MM_TO_PX` mm→px constant used by both the artboard
  renderer and the server-side printer), `promise`, `string`, `style` (`cn()` helper,
  breakpoints), `template` (`templatesList`), `types`.
- `tools/prisma` — `schema.prisma` (models: `User`, `Secrets`, `Resume`, `Statistics`) and
  `migrations/` (5 migrations, chronological, currently in sync with `schema.prisma`).
- `tools/compose` — six Docker Compose variants: `simple.yml` (bare, bring-your-own-proxy),
  `development.yml` (local dev services only — Postgres/MinIO/Chrome/Adminer, no app container),
  `nginx-proxy-manager.yml`, `traefik.yml`, `traefik-secure.yml` (Let's Encrypt), `swarm.yml`
  (Docker Swarm, multi-replica). The **root** `compose.yml` / `compose.dev.yml` are *not* real
  Compose files — they're one-line pointers telling you to use the `tools/compose/*.yml` files
  directly, e.g. `docker compose -f tools/compose/simple.yml --env-file .env.example -p reactive-resume up -d`.

### Resume templates

13 templates live in `apps/artboard/src/templates/*.tsx`, matched 1:1 against `templatesList` in
`libs/utils/src/namespaces/template.ts`: `azurill`, `bronzor`, `chikorita`, `ditgar`, `ditto`,
`gengar`, `glalie`, `kakuna`, `leafish`, `nosepass`, `onyx` (default fallback), `pikachu`,
`rhyhorn`. Twelve are Pokémon-named originals from upstream Reactive Resume; **`ditgar` is a
fork-added template** and won't automatically inherit fixes made to the others (it was
copy-pasted from similar boilerplate). If you fix a rendering bug in one template, check whether
it also applies to `ditgar` and the other 12.

## Placement decision tree

1. A route, page, or user-facing builder/dashboard/auth UI change → `apps/client/src/pages` (or
   `router`/`stores`/`services` if it's cross-cutting client state/data-fetching).
2. A visual change to how a *rendered resume* looks (in the live builder iframe, the public share
   page, or the exported PDF) → `apps/artboard/src/templates` or `apps/artboard/src/components`.
   Remember this same code renders in three contexts (client-embedded builder iframe, public
   preview iframe, and headless Puppeteer for PDF/preview generation) — don't assume a browser
   window/DOM API is always safe to use.
3. A backend/API change (new endpoint, auth logic, storage, PDF generation, email) →
   `apps/server/src/<module>`.
4. A change to what a resume's data can contain → start in `libs/schema` (the Zod model), then
   thread it through `libs/dto` (API contracts), `apps/artboard/src/templates` (rendering), and
   `apps/client/src/pages/builder/sidebars` (editing UI).
5. A shared, environment-agnostic utility used by 2+ apps → `libs/utils` (namespaced) or
   `libs/hooks` (React hooks) or `libs/ui` (shared components).
6. A resume-import format → `libs/parser`.

Workspace packages are imported by name (`@reactive-resume/schema`, `@reactive-resume/utils`,
`@reactive-resume/dto`, `@reactive-resume/ui`, `@reactive-resume/hooks`, `@reactive-resume/parser`),
via each lib's `index.ts` barrel export — not by deep-relative path across app/lib boundaries. Nx
project tags mark each project `frontend`, `backend`, or both (see each `project.json`), though
unlike a Turborepo setup there's no `turbo boundaries`-style enforced import-boundary check here —
just convention.

## Database

PostgreSQL via Prisma. Schema: `tools/prisma/schema.prisma`. Migrations: `tools/prisma/migrations/`.

```
pnpm prisma:generate       # prisma generate — regenerate the Prisma client after schema changes
pnpm prisma:migrate:dev    # prisma migrate dev — create + apply a new migration locally
pnpm prisma:migrate        # prisma migrate deploy — apply pending migrations (no new migration created)
```

**The production server auto-runs `prisma migrate deploy` on every container start** (`package.json`
`"prestart"` hook, ahead of `"start": "node dist/apps/server/main"`). This means a bad/partial
migration in the Postgres volume will block every subsequent `docker compose up`, not just the
first — keep that in mind when debugging "won't start" issues after a schema change.

## Environment

Copy `.env.example` to `.env`. Required (server fails fast at boot via a Zod schema in
`apps/server/src/config/schema.ts` if these are missing/malformed): `PUBLIC_URL`, `STORAGE_URL`,
`DATABASE_URL` (must be `postgresql://...`), `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`,
`CHROME_TOKEN`, `CHROME_URL`, `STORAGE_ENDPOINT`, `STORAGE_PORT`, `STORAGE_BUCKET`,
`STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`. Optional: SMTP vars (no `SMTP_URL` → emails are just
logged to console, not sent), Crowdin vars, GitHub/Google/OpenID OAuth vars (each provider
degrades to disabled, not a crash, if its env vars are absent), `DISABLE_SIGNUPS`,
`DISABLE_EMAIL_AUTH`.

**`.env.example` as shipped will not boot cleanly against `tools/compose/simple.yml` unmodified**:
`STORAGE_ACCESS_KEY=storageadmin` does not match `MINIO_ROOT_USER=minioadmin` (the app
authenticates to MinIO directly as its own root user — there's no separate IAM-user provisioning
anywhere in the repo), and `CHROME_URL=ws://host.docker.internal:3000` points at the `app`
container's own port rather than the `chrome`/browserless container, which will break PDF export.
Align `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` with whatever `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`
you actually set, and point `CHROME_URL` at the `chrome` service (e.g. `ws://chrome:3000`) for
`simple.yml`/`nginx-proxy-manager.yml`.

## Common commands

Dev dependency manager is **pnpm** (`engines.node >= 22.13.1`). Nx orchestrates all
build/serve/lint/test targets across the 3 apps + 6 libs.

| Task | Command | Notes |
|---|---|---|
| Install deps | `pnpm install` | |
| Run everything in dev | `pnpm dev` | `nx run-many -t serve` — starts client (`:5173`), artboard (`:6173`), and server (`:3000`) concurrently. Client's `proxy.conf.json` forwards `/api` → `:3000` and `/artboard` → `:6173`. |
| Lint | `pnpm lint` | `nx run-many -t lint` (ESLint, per-project) |
| Lint & autofix | `pnpm lint:fix` | |
| Format check | `pnpm format` | `prettier -c --log-level error .` |
| Format & write | `pnpm format:fix` | `prettier -w --log-level error .` |
| Test | `pnpm test` | Runs `pnpm vitest run` at the repo root — **only exercises Vitest-based projects**; see Testing note below. |
| Build | `pnpm build` | `nx run-many -t build` (runs `prisma:generate` first via `prebuild`) |
| Start (prod, after build) | `pnpm start` | Runs `prisma:migrate` first via `prestart`, then `node dist/apps/server/main` |
| Regenerate translation strings | `pnpm messages:extract` | `lingui extract --clean --overwrite` |
| Sync Crowdin | `pnpm crowdin:sync` | |

For a single project, prefer Nx directly instead of the repo-wide scripts:

```
pnpm exec nx build server
pnpm exec nx test utils
pnpm exec nx lint client
pnpm exec nx affected -t lint test build   # what CI actually runs (nx-ci.yml)
```

### What CI actually runs

- **`.github/workflows/nx-ci.yml`** (triggers on every push/PR to `main`) is the real gate:
  `pnpm exec nx affected -t lint test build`, distributed via Nx Cloud. This is the workflow to
  match locally before pushing.
- **`.github/workflows/lint-test-build.yml`** runs `pnpm run lint`, `pnpm run format`,
  `pnpm run test`, `pnpm run build` in sequence — but it only triggers via `workflow_dispatch` or
  after the (currently broken — see Gotchas) "Run Prettier and Language File Fixes" workflow
  completes, so treat it as secondary/manual, not as the primary CI signal.

## Testing — read this before claiming something is "tested"

**Only `libs/utils` has actual test files** (5 files under `libs/utils/src/namespaces/tests/`,
~40 cases, covering the `array`/`date`/`number`/`object`/`string` helper namespaces). Every other
project — `apps/client`, `apps/server`, `apps/artboard`, `libs/schema`, `libs/dto`, `libs/parser`,
`libs/hooks`, `libs/ui` — has **zero** test files, despite most of them having a Nx `test` target
scaffolded (`passWithNoTests: true`, so `nx test <project>` reports green with nothing to run).
`apps/artboard` doesn't even have a `test` target declared in its `project.json`.

Also note the root `pnpm test` script is plain `pnpm vitest run`, which only discovers
Vitest-based projects (client, artboard-adjacent libs, etc.) — `apps/server` uses **Jest**
(`@nx/jest:jest`, `apps/server/jest.config.ts`, `ts-jest`), a completely different runner. Running
`pnpm test` at the root does **not** invoke the server's Jest config; use
`pnpm exec nx test server` explicitly if you ever add server tests. If you write new tests,
prefer `pnpm exec nx test <project>` over trusting the root `pnpm test` to have covered
everything.

## Formatting & linting

Every file must conform to this repo's Prettier config (`.prettierrc`: `printWidth: 100`,
`endOfLine: "auto"`, plus `prettier-plugin-tailwindcss` for class-name sorting) before it's
considered done. Run `pnpm format:fix` (or `pnpm exec prettier -w <files>`) after any edit, not
just at the end of a task. ESLint config is `.eslintrc.json` at the root plus a per-project
`.eslintrc.json`; run `pnpm lint:fix` for autofixable issues.

Gotcha: `prettier-plugin-tailwindcss` resolves the project's real `tailwind.config.js`, which
requires the full `node_modules` (e.g. `@tailwindcss/forms`) to load without erroring. If a full
`pnpm install` isn't available in the environment, you can still validate base formatting
(quotes, semicolons, line width, trailing commas, etc.) by running Prettier with `--no-config`
and matching the `printWidth`/`endOfLine` options by hand — this won't re-sort Tailwind class
strings, so double-check any file where you touched a `className`/`cn(...)`/`cva(...)` call by
running the real config once `node_modules` is available.

## Gotchas

- **Line endings**: the working tree has historically drifted to CRLF while the git history is
  LF (`git diff -w` shows zero real changes even when `git status` shows every file modified).
  Before committing, check `git diff <file> | cat -A | head` for stray `^M` — normalize to LF
  (`sed -i 's/\r$//' <file>`) so diffs/PRs only show your actual changes.
- **No auto-pagination**: resume pages are only created by the user manually dragging sections
  into a new page via the builder's Layout panel (`apps/client/.../sidebars/right/sections/
  layout.tsx`). `apps/artboard/src/components/page.tsx` sizes each page with `min-height` only —
  content can overflow with no CSS-enforced page boundary. `apps/server/src/printer/
  printer.service.ts` now sizes exported PDF pages to the nominal `pageSizeMap[format]` dimensions
  (not measured `scrollHeight`) specifically so overflow gets paginated correctly by Chromium's
  native print engine instead of collapsing onto one oversized page — if you touch that file
  again, preserve that behavior (see git history: "Fix A4 PDF export producing one long page").
- **`/api/health/environment`** (`apps/server/src/health/health.controller.ts`) has no auth guard
  and dumps the entire parsed config (all secrets: JWT secrets, DB URL, storage keys, OAuth
  secrets) unless `process.env.NODE_ENV` is the exact literal string `"production"`. Be careful
  changing `NODE_ENV` handling anywhere near this.
- **`ResumeService.update()`** (`apps/server/src/resume/resume.service.ts`) only rethrows Prisma's
  `P2025` error; any other error (including the intentional "resume is locked" `BadRequestException`
  thrown earlier in the same method) is silently swallowed and returns `undefined` instead of a
  proper error response.
- **CI workflow health**: `sync-ai-translations.yml` runs a Python script under a bare `run:`
  step with no `shell: python`, so it fails immediately (bash trying to parse Python).
  `prettier-and-language-fixes.yml` force-pushes to `main` but its own logic discards the fixes it
  just made before committing (see the leftover `forced.txt` file at repo root — evidence this ran
  and did nothing useful). Don't assume either of these workflows does what its name implies.
- `nx.json` has a (low-risk, read-scoped) Nx Cloud access token committed in plaintext — not a
  reason to add more secrets to source, just noting it's there.
- `apps/artboard` templates render in three different contexts (client iframe, public-page iframe,
  headless Puppeteer) — avoid browser-only APIs without checking all three still work, and
  remember Puppeteer navigates to `/artboard/preview` and seeds data via `localStorage`, not via
  `postMessage`.
