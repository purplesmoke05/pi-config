# pi-config

Personal customizations for the [pi coding agent](https://pi.dev/): extensions, skills, and prompt templates, packaged as a [pi package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

Tested with `@earendil-works/pi-coding-agent` 0.79.1.

## Install

```bash
pi install git:github.com/purplesmoke05/pi-config
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/purplesmoke05/pi-config"]
}
```

## What's inside

| Path | Type | What it does |
|------|------|--------------|
| `extensions/hello/` | extension | Starter template: registers a `greet` tool and a `/hello` command |
| `skills/example-skill/` | skill | Placeholder documenting the SKILL.md layout |
| `prompts/` | prompt templates | Empty for now |

## Develop

Extensions are TypeScript, loaded by pi via jiti — no build step. To try one without installing:

```bash
pi -e ./extensions/hello/index.ts
```

Editor types and typecheck:

```bash
npm install
npm run typecheck
```

To work against a local checkout instead of the pinned git ref, point settings at the directory:

```json
{
  "packages": ["/path/to/pi-config"]
}
```

## Layout rules

- `extensions/`: one directory per extension with an `index.ts` entry point; single `.ts` files also load.
- `skills/`: one directory per skill containing a `SKILL.md` with `name` and `description` frontmatter.
- `prompts/`: `.md` prompt templates.
- No secrets in this repository. API keys and machine-specific settings live outside (managed separately via Nix/sops).

## License

MIT
