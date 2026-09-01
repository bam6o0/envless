# envless

**Declare where your environment variables come from, not what they are.** envless resolves
them at launch and injects them into the child process — no `.env` files, no secrets on disk.

[![CI](https://github.com/bam6o0/envless/actions/workflows/ci.yml/badge.svg)](https://github.com/bam6o0/envless/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)
![status](https://img.shields.io/badge/status-early-orange.svg)

```bash
npm install -g github:bam6o0/envless
```

## Why

[portless](https://portless.sh) gives every worktree a stable URL so you never think about
port numbers. envless does the same for environment variables.

A `.env.local` is a file that every developer has, that no two copies of agree on, and that
holds a plaintext secret in every worktree you create. It is also the reason a fresh
worktree cannot just start: something has to be copied into it first, by a human who knows
what the values are.

envless replaces that file with a committed manifest that says *where* each value comes
from. Any checkout, any worktree, any machine resolves the same environment from it — and
the values exist only in the environment of the process that needs them.

## Quick start

Put `envless.json` at the project root and commit it:

```json
{
  "env": {
    "API_URL": "https://api.example.com",
    "CLIENT_SECRET": "gcp://my-project/my-client-secret",
    "TENANT_SLUG": null
  }
}
```

Run anything through it:

```bash
envless run npm run dev
```

```
envless: /path/to/envless.json
  API_URL (literal)
  CLIENT_SECRET (secret)
  TENANT_SLUG (from environment)
```

The manifest is found by walking up from the working directory, so this works from any
subdirectory and in any linked worktree.

## Manifest reference

Each value under `env` declares a source:

| Value | Meaning |
|---|---|
| `"..."` | literal |
| `"gcp://<project>/<secret>"` | Google Secret Manager, `latest` version (`#<version>` to pin) |
| `"{{ portless.url }}"` | the app's URL from [portless](https://portless.sh); `{{ portless.host }}` for host and port. Usable inside a larger string |
| `null` | required: must already be in the environment, otherwise envless refuses to start |

A literal can be anything, including a URL with a scheme of its own — a
`postgresql://…` connection string is a value, not a place to fetch from. Only a scrambled
spelling of a reference scheme (`gpc://…`) or an unknown placeholder (`{{ brunch }}`) is
treated as a typo and rejected before anything starts, along with a `gcp://` reference that
does not parse.

## CLI reference

```
envless run <command> [args...]   Run a command with the manifest's variables in its environment
envless --help
envless --version
```

As far as the terminal is concerned, `envless run` behaves like the command it wraps: stdio
is inherited, Ctrl-C is forwarded, and the child's exit code becomes envless's own. The
project's `node_modules/.bin` is added to the child's PATH, so `envless run next dev` works
without an `npm run` in between.

| Exit code | Meaning |
|---|---|
| child's code | the command ran |
| `127` | command not found |
| `1` | envless could not resolve the environment, or the child was killed by a signal |

`PORTLESS_URL` is read from the environment when a manifest uses `{{ portless.* }}`.

## Google Secret Manager

`gcp://` references authenticate with Application Default Credentials, so log in once:

```bash
gcloud auth application-default login
```

The identity needs `roles/secretmanager.secretAccessor` on each referenced secret. If it
does not, or ADC is missing, envless says so and refuses to start the command — it never
starts your app with a half-resolved environment. A manifest with no `gcp://` reference
never loads the Secret Manager SDK and never needs credentials at all.

## With portless

`{{ portless.url }}` fills in the per-worktree URL that portless assigns, so a public base
URL or an OAuth callback needs no per-worktree value anywhere:

```json
{
  "env": {
    "PUBLIC_URL": "{{ portless.url }}",
    "CALLBACK_URL": "{{ portless.url }}/api/auth/callback"
  }
}
```

**portless has to be the outer command:**

```bash
portless run envless run next dev     # correct
envless run portless run next dev     # {{ portless.url }} cannot resolve
```

portless assigns the port and URL when it starts the process it wraps, so it has to run
first: envless reads the `PORTLESS_URL` that portless put in its environment. In the other
order envless would have to guess a URL that does not exist yet, and it refuses instead —
the error tells you to swap the order.

Everything else works in either order, and a variable already in the environment still
wins, so `PUBLIC_URL=http://localhost:3000 envless run next dev` needs no portless at all.

## Design

- **Values only ever reach the child process.** envless writes no files and has no command
  that prints a resolved value — not even a masked one. There is nothing to accidentally
  commit, `cat`, or leave behind in a worktree.
- **The environment wins.** A variable already set is used as-is and its secret is never
  fetched. That is both the override mechanism and the offline escape hatch:
  `CLIENT_SECRET=xxx envless run npm run dev`.
- **Fail loudly, with the fix.** Missing credentials, missing permission, a wrong secret
  name, a mistyped scheme: each says what to do about it. An agent gets an actionable
  message instead of an app that booted with `gpc://…` as its password.
- **No caching.** Every start resolves from the source, so a rotated secret takes effect on
  the next run and nothing stale lives anywhere. The cost is one API call per start and no
  offline start unless you pass the value yourself.

envless is built for local development. It is not a production secret loader: production
platforms already inject secrets into the process (Cloud Run's `secretKeyRef`, ECS secrets,
Kubernetes), and envless is the equivalent for the machine you develop on.

## Status

Early. It does what the sections above describe and nothing more; the manifest format may
still change. Wanted next:

- `{{ branch }}` / `{{ worktree }}` templates for per-worktree database names, bucket
  prefixes and the like
- Backends beyond GCP (1Password, AWS Secrets Manager, Vault)
- Per-user overrides in a state dir outside the repo (`~/.envless/<project>/<worktree>`)
- Profiles, for switching between environments in one manifest

## Development

```bash
npm install       # also builds dist/ through the prepare script
npm test          # node:test, no network
npm run typecheck
npm run build     # src/*.ts -> dist/*.js
```

The sources are TypeScript and the tests run them directly (Node 24 strips types), but the
published `bin` points at `dist/`: Node refuses to strip types for files under
`node_modules`, so an installed copy has to be plain JavaScript.

Issues and pull requests are welcome. Secret resolution is injected as a function
(`SecretFetcher`), so backends and manifest changes can be tested without touching a
network or a cloud account — please keep new tests offline.

## License

[MIT](LICENSE) © Takato Sasagawa
