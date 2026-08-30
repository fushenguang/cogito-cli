# AgentDock CLI

**`@cogito.ai/cli`** — Scaffold production-ready AI coding agent projects for humans, CI pipelines, and AI agents.

[![npm version](https://img.shields.io/npm/v/@cogito.ai/cli)](https://www.npmjs.com/package/@cogito.ai/cli)

---

## Quick Start

```bash
# Interactive mode (for humans)
npx @cogito.ai/cli init

# Headless mode (for CI / AI agents)
npx @cogito.ai/cli init --name my-app --template web-nextjs --pm pnpm --json

# Start MCP Stdio server (for AI agents via Model Context Protocol)
npx @cogito.ai/cli mcp
```

## Installation

```bash
# Run without installing (recommended)
npx @cogito.ai/cli <command>

# Global install
npm install -g @cogito.ai/cli
pnpm add -g @cogito.ai/cli
```

---

## Commands

### `agentdock init`

Scaffold a new project from a template. Auto-detects the environment:

- **TTY** → interactive prompts (human mode)
- **Non-TTY / `--silent` / `--json`** → headless execution (agent/CI mode)

| Flag         | Type    | Default    | Description                                      |
| ------------ | ------- | ---------- | ------------------------------------------------ |
| `--name`     | string  | required   | Project name and target directory name           |
| `--template` | string  | required   | Template ID (e.g. `web-nextjs`)                  |
| `--pm`       | string  | `pnpm`     | Package manager: `pnpm` / `npm` / `yarn` / `bun` |
| `--dir`      | string  | `./<name>` | Target directory (absolute or relative to cwd)   |
| `--json`     | boolean | `false`    | Output NDJSON result to stdout                   |
| `--silent`   | boolean | `false`    | Suppress all output                              |

**JSON output (success):**

```json
{ "ok": true, "targetDir": "/path/to/my-app", "name": "my-app", "template": "web-nextjs" }
```

**JSON output (failure):**

```json
{
  "ok": false,
  "error": "TARGET_DIR_EXISTS",
  "message": "Directory already exists: /path/to/my-app"
}
```

**Error codes:** `MISSING_ARG` · `TEMPLATE_NOT_FOUND` · `TARGET_DIR_EXISTS` · `CLI_VERSION_OUTDATED` · `SCAFFOLD_FAILED`

---

### `agentdock mcp`

Start an MCP (Model Context Protocol) Stdio server. Exposes CLI capabilities as tools directly callable by AI agents.

```bash
agentdock mcp
```

**Available tools:**

| Tool               | Description                                |
| ------------------ | ------------------------------------------ |
| `list_templates`   | List all available project templates       |
| `scaffold_project` | Scaffold a project into a target directory |

**VS Code Copilot MCP config (`.vscode/mcp.json`):**

```json
{
  "servers": {
    "agentdock": {
      "type": "stdio",
      "command": "npx",
      "args": ["@cogito.ai/cli", "mcp"]
    }
  }
}
```

---

## Available Templates

| Template ID  | Description                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| `web-nextjs` | Next.js 16 + Supabase + next-intl + Tailwind CSS v4 + Vitest + Fumadocs — full-stack monorepo starter |

---

## Architecture

The CLI uses an **Adapter pattern** — a single executor core serves three consumer surfaces:

```
agentdock init
      │
      ├── TTY detected ──→ Human Adapter  (Clack interactive UI)
      └── Non-TTY / flags ──→ Agent Adapter (structured JSON output)

agentdock mcp ──→ MCP Adapter (MCP Stdio Server)

All adapters share the same Core Executor (scaffold + registry)
```

**Design principles:**

1. **Headless-first** — the executor core has no TTY dependency; the human UI is a thin shell on top.
2. **Structured output as protocol** — `--json` mode produces stable machine-parseable NDJSON, not natural language.
3. **One capability, three surfaces** — `scaffold_project` is implemented once and projected to CLI flags, JSON mode, and MCP tool automatically.

**Tech stack:**

| Component                                                                    | Role                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| [Bun](https://github.com/oven-sh/bun)                                        | Build: single-file Node.js executable                     |
| [Citty](https://github.com/unjs/citty)                                       | Command modeling: sub-commands, flag schema, lazy loading |
| [Clack](https://github.com/bombshell-dev/clack)                              | Human interaction: TTY prompts                            |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Agent protocol: MCP Stdio server                          |
| [Changesets](https://github.com/changesets/changesets)                       | Release governance: semantic versioning + changelog       |

---

## Development

```bash
# Install dependencies
pnpm install

# Regenerate template registry
pnpm --filter @cogito.ai/cli generate-registry

# Run from source (no build needed)
npx tsx packages/cli/bin/agentdock.ts init

# Run tests
pnpm --filter @cogito.ai/cli test

# Build
pnpm --filter @cogito.ai/cli build
```

### Adding a template

1. Create `templates/<id>/` with a complete project structure.
2. Add `package.json` with `"agentdock": { "minCliVersion": "x.y.z" }`.
3. Run `pnpm --filter @cogito.ai/cli generate-registry`.
4. Publish a new CLI version — templates are bundled inside the npm package.

### Publishing a new version

```bash
pnpm changeset          # describe the change
pnpm changeset version  # bump version + update CHANGELOG
pnpm --filter @cogito.ai/cli build
pnpm --filter @cogito.ai/cli publish
```

---

## License

MIT

---

[中文文档 →](./README-zh.md)
