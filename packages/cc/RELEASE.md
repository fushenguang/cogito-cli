# AgentDock CLI — Release Process & Conventions

> A reference document for AI Coding Agent projects that want to adopt the same release rigor as `@cogito.ai/cli`.
>
> **Target audience:** AI coding agents and their human operators who need a repeatable, machine-auditable release pipeline for CLI tooling distributed via npm.

---

## Table of Contents

1. [Overview](#overview)
2. [Version Management](#version-management)
3. [Build Pipeline](#build-pipeline)
4. [npm Publishing Conventions](#npm-publishing-conventions)
5. [CI/CD Release Pipeline](#cicd-release-pipeline)
6. [Version Compatibility Contract](#version-compatibility-contract)
7. [Pre-release Quality Gates](#pre-release-quality-gates)
8. [Step-by-Step Release Manual](#step-by-step-release-manual)
9. [Common Pitfalls](#common-pitfalls)

---

## Overview

The AgentDock CLI (`@cogito.ai/cli`) is a scaffold tool distributed as an npm package. It bundles project templates, runs a headless-first core executor, and exposes capabilities to both humans (interactive TTY) and AI agents (JSON over stdout / MCP stdio).

The release pipeline is built on three principles:

1. **Changesets as single source of truth** — one tool governs version bumps, changelogs, and publishing across all workspace packages.
2. **CI-only publish** — no human ever runs `pnpm publish` locally; the `release.yml` workflow is the sole publishing mechanism.
3. **Template-in-package bundling** — templates are pre-built and shipped inside the CLI npm tarball so that `npx @cogito.ai/cli init` works with zero network dependency.

---

## Version Management

### Tooling

We use [**Changesets**](https://github.com/changesets/changesets) (`@changesets/cli@^2.31.0`) installed at the monorepo root.

Changesets scans every workspace package and determines version bumps based on `.changeset/*.md` files committed to the repository.

### Scripts (root `package.json`)

```json
{
  "scripts": {
    "changeset": "changeset",
    "changeset:version": "changeset version",
    "changeset:publish": "changeset publish"
  }
}
```

### Three-step flow

| Step        | Command                  | What happens                                                                                                                                          |
| ----------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Describe | `pnpm changeset`         | Interactive CLI asks which packages changed, bump type (major/minor/patch), and description. Writes a `.changeset/<slug>.md` file.                    |
| 2. Consume  | `pnpm changeset:version` | Reads all `.changeset/*.md` files, bumps versions in affected `package.json` files, updates `CHANGELOG.md` entries, deletes consumed changeset files. |
| 3. Publish  | `pnpm changeset:publish` | Builds changed packages, runs `npm publish` (or `pnpm publish`) for each, creates git tags.                                                           |

Steps 1 is manual; steps 2–3 are automated by `changesets/action@v1` in CI.

### CHANGELOG format

CHANGELOG.md follows the Changesets auto-generated format:

```markdown
# @cogito.ai/cli

## 0.4.10

### Patch Changes

- 2ba5b10: add supabase schema

## 0.4.0

### Minor Changes

- dff1e2b: refine web-nextjs template
```

- **Patch Changes** — bug fixes, small tweaks. Bumps `0.x.Y`.
- **Minor Changes** — new features or non-trivial enhancements. Bumps `0.Y.0`.
- **Major Changes** — breaking changes (not yet used; would bump `Y.0.0`).

Each entry maps to a commit hash prefix. Changesets enforces this format; do not hand-edit CHANGELOG.md outside of the `changeset version` process.

### Version in code

The runtime version is read at **build time** by Bun via a JSON import:

```typescript
// packages/cli/src/version.ts
import pkg from '../package.json' with { type: 'json' }

export const VERSION: string = pkg.version
```

Bun inlines the JSON at build time, so the bundled `dist/index.js` always reports the correct published version when `agentdock --version` is invoked. There is no runtime file read.

### Version in templates

Each template declares a `minCliVersion` in its `package.json` under the `agentdock` key:

```json
// templates/web-nextjs/package.json
{
  "agentdock": {
    "minCliVersion": "0.4.0"
  }
}
```

The CLI checks this at scaffold time and refuses to scaffold with an outdated CLI version (see [Version Compatibility Contract](#version-compatibility-contract)).

> **Rule:** When a template adds a new feature that depends on a CLI-side behavior, bump `minCliVersion` to the CLI version that introduces that behavior.

---

## Build Pipeline

### Build command

```bash
pnpm --filter @cogito.ai/cli build
```

This runs as part of `turbo run build` (the monorepo-wide build). The CLI's `build` script in `package.json` executes the following steps **in order**:

```
1. pnpm run generate-registry     # generate registry.json
2. bun build bin/agentdock.ts
   --outfile dist/index.js
   --target node                  # single-file Node.js executable
3. cp src/registry.json dist/registry.json
4. rm -rf dist/templates
5. mkdir -p dist/templates
6. rsync -a --exclude='node_modules/' --exclude='.next/' --exclude='.turbo/'
   ../../templates/ dist/templates/
7. find dist/templates -name '.gitignore' -exec ... rename to _gitignore \;
8. find dist/templates -name '.npmrc' -exec ... rename to _npmrc \;
```

**Key points:**

- **Bun build** produces a single-file Node.js bundle at `dist/index.js`. The `bin` field in `package.json` points to this file.
- **Templates are copied** from the monorepo's `templates/` directory into `dist/templates/`. They ship inside the npm tarball.
- **Dotfiles are renamed** (`.gitignore` → `_gitignore`, `.npmrc` → `_npmrc`) because npm hardcodes exclusion of `.gitignore` and `.npmrc` from published tarballs. The scaffold logic in `src/core/scaffold.ts` renames them back after copying to the target directory.

### Turbo task graph

```json
// turbo.json
{
  "tasks": {
    "generate-registry": {
      "inputs": ["../../templates/*/package.json", "../../packages/*/package.json"],
      "outputs": ["src/registry.json"]
    },
    "build": {
      "dependsOn": ["^build", "generate-registry"],
      "outputs": [".next/**", "!.next/cache/**", "dist/**"]
    }
  }
}
```

`generate-registry` runs **before** `build` (via `dependsOn`). Turbo caches `src/registry.json` based on the declared `inputs`. If no template or package `package.json` changed, `generate-registry` is a cache hit.

### Template registry generation

The script at `scripts/generate-registry/index.ts`:

1. Scans `templates/*/package.json`
2. Extracts `id`, `name`, `description`, `version`, `minCliVersion`
3. Resolves `workspace:*` dependencies to their current semver version from the corresponding `packages/*/package.json`
4. Writes `packages/cli/src/registry.json` with the resolved values

**Example output (`src/registry.json`):**

```json
{
  "version": "1",
  "templates": [
    {
      "id": "web-nextjs",
      "name": "AgentDock Web Next.js Starter",
      "description": "Next.js 16 + Supabase + next-intl + Tailwind CSS v4 + Vitest + Fumadocs",
      "minCliVersion": "0.4.0",
      "source": "templates/web-nextjs",
      "resolvedDependencies": {
        "@cogito.ai/eslint-config": "^0.1.0",
        "@cogito.ai/tsconfig": "^0.1.0"
      }
    }
  ]
}
```

The registy is read at runtime by `src/core/registry.ts`. During local development (`npx tsx`), it reads from `src/registry.json`; in the built artifact, it reads from `dist/registry.json`.

---

## npm Publishing Conventions

### Package metadata (`package.json`)

```json
{
  "name": "@cogito.ai/cli",
  "version": "0.4.10",
  "publishConfig": {
    "access": "public"
  },
  "bin": {
    "agentdock": "./dist/index.js"
  },
  "main": "./dist/index.js",
  "files": ["dist/"],
  "engines": {
    "node": ">=18"
  }
}
```

| Field                  | Rationale                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publishConfig.access` | `"public"` — the package is scoped (`@cogito.ai/`) but publicly installable. Without this, npm defaults to restricted for scoped packages.                            |
| `files`                | `["dist/"]` — **only** the build output is published. Source files, tests, and config are excluded. This keeps the tarball small and avoids leaking internal tooling. |
| `bin.agentdock`        | Points to the bundled entry point. `npx @cogito.ai/cli` invokes this file.                                                                                            |
| `engines.node`         | `>=18` — minimum Node.js version. npm warns (or fails in strict mode) when installed on older Node.                                                                   |

### .npmignore — the critical trap

The CLI package has a **minimal** `.npmignore`:

```
# Intentionally minimal — "files": ["dist/"] in package.json controls what gets published.
#
# This file MUST exist so npm uses it instead of falling back to the root .gitignore.
# The root .gitignore contains a bare `dist` pattern that matches any directory named
# `dist` at any depth, which would strip `dist/templates/*/packages/*/dist/` (the
# pre-built workspace packages inside the bundled templates).
#
# By having a local .npmignore, npm no longer reads the root .gitignore for this package,
# and the `files` field alone controls inclusion — leaving nested dist/ directories intact.
!.gitignore
!.npmrc
```

**Why this matters:**

- npm's default behavior: if a `.npmignore` exists, use it. If not, fall back to `.gitignore`.
- The monorepo root `.gitignore` contains a bare `dist` entry (to ignore all build output).
- Without this local `.npmignore`, npm would apply the root `.gitignore` and **strip nested `dist/` directories** inside the bundled templates (e.g., `dist/templates/web-nextjs/packages/eslint-config/dist/`).
- The `!` negations (`!.gitignore`, `!.npmrc`) are placeholders — they don't actually include these files (the `files` field controls that), but they prevent npm from issuing warnings about excluded common files.

**Rule:** Every publishable package that bundles nested `dist/` directories MUST have its own `.npmignore` to break the chain to the root `.gitignore`.

### Dotfile rename for npm publish survival

npm hardcodes exclusion of `.gitignore` and `.npmrc` from tarballs — even if `files` explicitly includes them.

**Workaround in build step (step 7–8):**

```bash
find dist/templates -name '.gitignore' -exec sh -c 'mv "$1" "${1%/*}/_gitignore"' _ {} \;
find dist/templates -name '.npmrc' -exec sh -c 'mv "$1" "${1%/*}/_npmrc"' _ {} \;
```

**Restoration at scaffold time (`src/core/scaffold.ts`):**

```typescript
function restoreDotfiles(dir: string): void {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      restoreDotfiles(fullPath)
    } else if (entry.name === '_gitignore') {
      renameSync(fullPath, join(dir, '.gitignore'))
    } else if (entry.name === '_npmrc') {
      renameSync(fullPath, join(dir, '.npmrc'))
    }
  }
}
```

This ensures the scaffolded project always has proper `.gitignore` and `.npmrc` files, regardless of npm's packaging restrictions.

### workspace:\* dependency resolution

Templates in the monorepo use `workspace:*` to reference sibling packages (e.g., `@cogito.ai/eslint-config`). These are NOT valid in a standalone npm package.

**Resolution at registry generation time:**

1. Find the target package in `packages/` by matching `name` in its `package.json`
2. Read its `version` field
3. Record as `"^X.Y.Z"` in `resolvedDependencies`

**Rewriting at scaffold time (`scaffold.ts`):**

```typescript
for (const [dep, ver] of Object.entries(deps)) {
  if (ver === 'workspace:*' && resolvedDependencies[dep]) {
    deps[dep] = resolvedDependencies[dep]
  }
}
```

The scaffolded project's `package.json` gets installable semver ranges instead of `workspace:*`.

---

## CI/CD Release Pipeline

### Workflow: `.github/workflows/release.yml`

**Trigger:** Every push to `main`.

**Concurrency:** `group: release-${{ github.ref }}`, `cancel-in-progress: false`.

> Canceling a release in-progress is **dangerous** — some packages may have been published (and tagged in npm) while others haven't, leaving the monorepo in an inconsistent state. This concurrency strategy ensures every push to main gets its own release run that completes fully.

**Steps:**

| Step       | Action                                                                  | Notes                                                                       |
| ---------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Checkout   | `actions/checkout@v4` with `fetch-depth: 0`                             | Full git history required for Changesets changelog generation               |
| Bun        | `oven-sh/setup-bun@v2`                                                  | CLI build requires `bun build`                                              |
| pnpm       | `pnpm/action-setup@v4`                                                  | Package manager                                                             |
| Node       | `actions/setup-node@v4` with `registry-url: https://registry.npmjs.org` | npm auth for publish                                                        |
| Auth       | `echo "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}" >> .npmrc`  | Token-based auth                                                            |
| Install    | `pnpm install --frozen-lockfile`                                        | Reproducible install                                                        |
| Build      | `pnpm build`                                                            | Full monorepo build (generates registry, bundles CLI, pre-builds templates) |
| Publish/PR | `changesets/action@v1`                                                  | Two-mode behavior (see below)                                               |

### Changesets Action — two modes

The `changesets/action@v1` GitHub Action operates in two distinct modes depending on repository state:

**Mode 1: Changeset files exist (`.changeset/*.md`)**

→ Opens or updates a **"Version Packages" PR** that contains:

- Version bumps in affected `package.json` files
- Updated `CHANGELOG.md` entries
- Deletion of the consumed `.changeset/*.md` files

The PR stays open for review. No packages are published.

**Mode 2: "Version Packages" PR is merged**

→ The merge commit triggers a new push to `main`. The action detects that the PR was a versioning PR and:

1. Runs `pnpm changeset:version` (no-op; versions already bumped)
2. Runs `pnpm changeset:publish` — builds and publishes each changed package to npm
3. Creates git tags for each published version

**Configuration:**

```yaml
- uses: changesets/action@v1
  with:
    publish: pnpm changeset:publish
    version: pnpm changeset:version
    commit: 'chore: version packages'
    title: 'chore: version packages'
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Required secrets

| Secret         | Scope                                     | Purpose                                                          |
| -------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| `NPM_TOKEN`    | Repository → Settings → Secrets → Actions | npm token with **Automation** type (bypasses 2FA) for CI publish |
| `GITHUB_TOKEN` | Auto-provided by GitHub Actions           | Create release PRs, commit changes, push tags                    |

**NPM_TOKEN setup:**

1. Generate at [npmjs.com → Access Tokens](https://www.npmjs.com/settings/<user>/tokens)
2. Select type: **Automation** (required for CI; standard "Publish" tokens with 2FA will fail)
3. Add to repository: Settings → Secrets and variables → Actions → New repository secret
4. Name: `NPM_TOKEN`

---

## Version Compatibility Contract

### Template-side declaration

Each template declares a minimum CLI version in its `package.json`:

```json
{
  "agentdock": {
    "minCliVersion": "0.4.0"
  }
}
```

This is extracted by the registry generator and stored in `registry.json` as `minCliVersion`.

### CLI-side enforcement

Before scaffold, the CLI compares its own version against the template's `minCliVersion`:

```typescript
// src/core/version.ts
export function checkVersion(cliVersion: string, minCliVersion: string, templateId: string): void {
  if (!isVersionCompatible(cliVersion, minCliVersion)) {
    const err: VersionOutdatedError = {
      ok: false,
      error: 'CLI_VERSION_OUTDATED',
      context: {
        cli_version: cliVersion,
        min_required: minCliVersion,
        template: templateId,
      },
      suggested_action: 'npm install -g @cogito.ai/cli@latest',
    }
    throw err
  }
}
```

### Semver comparison logic

```typescript
function isVersionCompatible(cliVersion: string, minCliVersion: string): boolean {
  const [cMaj, cMin, cPatch] = parseSemver(cliVersion)
  const [mMaj, mMin, mPatch] = parseSemver(minCliVersion)

  if (cMaj !== mMaj) return cMaj > mMaj
  if (cMin !== mMin) return cMin > mMin
  return cPatch >= mPatch
}
```

No external semver library — self-contained implementation for zero-dependency guarantee.

### Machine-readable error output

When the version check fails, the Agent adapter emits structured JSON:

```json
{
  "ok": false,
  "error": "CLI_VERSION_OUTDATED",
  "message": "CLI version 0.3.0 is older than required 0.4.0 for template web-nextjs",
  "context": {
    "cli_version": "0.3.0",
    "min_required": "0.4.0",
    "template": "web-nextjs"
  },
  "suggested_action": "npm install -g @cogito.ai/cli@latest"
}
```

An AI agent can parse `suggested_action` and autonomously run the upgrade command before retrying.

### Error code registry

| Error Code             | Meaning                                          | Exit Code |
| ---------------------- | ------------------------------------------------ | --------- |
| `CLI_VERSION_OUTDATED` | CLI version below template `minCliVersion`       | 2         |
| `TARGET_DIR_EXISTS`    | Target directory already exists and is not empty | 1         |
| `TEMPLATE_NOT_FOUND`   | Requested template ID not in registry            | 1         |
| `SCAFFOLD_FAILED`      | Unexpected error during scaffold                 | 1         |
| `MISSING_ARG`          | Required flag not provided in agent mode         | 1         |

Exit code 2 for version errors is intentional — it allows CI scripts to distinguish "update your tool" (exit 2) from "fix your arguments" (exit 1).

---

## Pre-release Quality Gates

Every PR to `main` or `release/**` must pass CI checks before merging. The release workflow **builds on top of these gates** — it only runs on `main` after all PR checks have passed.

### CI Fast (`.github/workflows/ci-fast.yml`)

Runs on `pull_request` targeting `main` and `release/**`. Four parallel jobs:

| Job            | Tool                        | What it checks                                                   |
| -------------- | --------------------------- | ---------------------------------------------------------------- |
| **type-check** | `tsc --noEmit`              | TypeScript strict mode, no type errors in any package            |
| **lint**       | ESLint                      | Code style, convention rules, Layer 2 architectural imports      |
| **arch-guard** | `dependency-cruiser`        | No forbidden dependencies between packages, Layer 2 isolation    |
| **build**      | `turbo build` + `bun build` | All packages build successfully, registry generated, CLI bundled |
| **test**       | Vitest                      | All unit tests pass (depends on `build` job for registry.json)   |

### Additional checks (other workflows)

| Workflow                  | Trigger               | Checks                                              |
| ------------------------- | --------------------- | --------------------------------------------------- |
| `align-check.yml`         | On-demand / scheduled | Template ↔ spec alignment, drift detection          |
| `ci-full.yml`             | Push to `main`        | Full suite including secret scanning (`secretlint`) |
| `template-validation.yml` | On template changes   | E2E scaffold + build test on generated project      |

### Local pre-release checklist

Before adding a changeset, run locally:

```bash
pnpm check-types    # TypeScript strict mode
pnpm lint           # ESLint
pnpm build          # Full build (generates registry, bundles CLI)
pnpm --filter @cogito.ai/cli test  # Unit tests
pnpm format         # Prettier (should produce no diff)
openspec validate   # If using OpenSpec for change tracking
```

All must exit 0 before a release is ready.

---

## Step-by-Step Release Manual

### For human operators

#### 1. Make your changes

Develop features/fixes on a branch. Ensure CI Fast passes on the PR.

#### 2. Create a changeset

```bash
pnpm changeset
```

The interactive CLI will ask:

- **Which packages changed?** Select `@cogito.ai/cli` (and any other affected packages).
- **What kind of change?** `patch` for fixes, `minor` for features.
- **Summary:** A concise description of the change (appears in CHANGELOG.md).

A new file appears in `.changeset/` (e.g., `.changeset/twelve-owls-sing.md`). Commit this file.

#### 3. Merge to main

Open a PR with your changes + the `.changeset/*.md` file. Once CI passes, merge to `main`.

#### 4. Changesets action opens a "Version Packages" PR

After merging, the `release.yml` workflow runs. It detects the `.changeset/*.md` file and opens/updates a PR titled **"chore: version packages"**.

This PR contains:

- Bumped version in `packages/cli/package.json`
- Updated `packages/cli/CHANGELOG.md`
- Deleted `.changeset/*.md` files

#### 5. Review and merge the Version Packages PR

Review the version bump and changelog. Merge when ready.

#### 6. Automatic publish

Merging the Version Packages PR triggers `release.yml` again. This time, the action detects it's a versioning PR and publishes to npm:

- `pnpm build` runs for all packages
- `changeset publish` publishes each changed package
- Git tags are created (e.g., `@cogito.ai/cli@0.4.10`)

#### 7. Verify

```bash
npm view @cogito.ai/cli version   # should show new version
npx @cogito.ai/cli --version      # should show new version
```

### For AI coding agents

An AI agent operating in this repository should follow the same flow:

1. Create or edit files within the approved scope
2. Run `pnpm changeset` and select affected packages
3. The changeset CLI is interactive but can be scripted:

```bash
# Non-interactive changeset creation
echo '{
  "releases": {
    "@cogito.ai/cli": "patch"
  },
  "summary": "Fix template routing bug with i18n Link double-locale"
}' | pnpm changeset add --empty
```

4. Commit and push. CI handles the rest.

> **See also:** `.github/copilot-instructions.md` and `AGENTS.md` for agent autonomy boundaries in this repository.

---

## Common Pitfalls

### 1. "Template packaging trap" — missing nested dist/

**Symptom:** `pnpm publish` succeeds but the scaffolded project is missing pre-built packages (e.g., `packages/eslint-config/dist/` is empty).

**Root cause:** The root `.gitignore` contains a bare `dist` pattern that matches at any directory depth. Without a local `.npmignore`, npm applies `.gitignore` and strips nested `dist/` directories.

**Fix:** Add a minimal `.npmignore` to the CLI package (see [.npmignore section](#npmignore--the-critical-trap)).

### 2. Dotfiles missing in scaffolded project

**Symptom:** After `agentdock init`, the generated project has no `.gitignore` or `.npmrc` files.

**Root cause:** npm hardcodes exclusion of `.gitignore` and `.npmrc` from tarballs.

**Fix:** Rename dotfiles to `_gitignore` / `_npmrc` at build time, restore them at scaffold time (see [Dotfile rename section](#dotfile-rename-for-npm-publish-survival)).

### 3. Release Bot diverge

**Symptom:** The "Version Packages" PR keeps getting updated with the same changes, never stabilizes.

**Root cause:** Multiple branches adding changesets to `.changeset/` in parallel, causing merge conflicts or duplicated changesets.

**Fix:** Serialize changeset creation. If parallel changes are unavoidable, ensure the Version Packages PR is merged before new changesets are added.

### 4. CI-only publish — never publish locally

**Symptom:** A developer runs `pnpm publish` locally and breaks the release pipeline.

**Root cause:** The `release.yml` workflow is the **sole** publishing mechanism. Local publish bypasses Changesets, misses version bumps, and may publish with stale build artifacts.

**Fix:** Never run `pnpm --filter @cogito.ai/cli publish` locally. All publishing goes through CI.

### 5. NPM_TOKEN with wrong type

**Symptom:** CI publish fails with `403 Forbidden` or `E403`.

**Root cause:** The npm token was created with type "Publish" (which requires 2FA) instead of "Automation" (which bypasses 2FA for CI).

**Fix:** Generate a new token with type **Automation** at npmjs.com. Automation tokens are specifically designed for CI/CD pipelines.

### 6. workspace:\* leaking into published registry

**Symptom:** `registry.json` contains `"@cogito.ai/eslint-config": "workspace:*"` instead of a real version.

**Root cause:** `generate-registry` didn't run before `build`, or the target package has no `version` field.

**Fix:** Ensure Turbo task dependency graph is correct (`build.dependsOn: ["generate-registry"]`). Verify the target package has a valid `version` in its `package.json`.

### 7. Turbo cache masking changes

**Symptom:** Changed a template's `package.json` but `registry.json` wasn't regenerated.

**Root cause:** Turbo `inputs` configuration for `generate-registry` doesn't match the actual files being read. The `inputs` glob uses `../../templates/*/package.json` which must correctly resolve from the CLI package directory.

**Fix:** Verify `turbo.json` → `tasks.generate-registry.inputs` matches the actual template paths. Use `turbo run generate-registry --force` to bypass cache during debugging.

---

## Reference

- [Changesets Documentation](https://github.com/changesets/changesets)
- [changesets/action](https://github.com/changesets/action)
- [npm publish docs — files field](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#files)
- [npm .npmignore behavior](https://docs.npmjs.com/cli/v10/using-npm/developers#keeping-files-out-of-your-package)
- [Bun build — single-file executable](https://bun.sh/docs/bundler)
- AgentDock Builder Workflow: `apps/docs/content/docs/builder-workflow.mdx`
- AgentDock AGENTS.md (autonomy boundaries): `AGENTS.md`
