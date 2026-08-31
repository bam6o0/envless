# envless

Resolve environment variables from a committed manifest and inject them into the child
process. No `.env` files, no secrets on disk.

`portless` gives every worktree a stable URL so you never think about port numbers.
`envless` does the same for environment variables: the repo declares *where* each value
comes from, and every worktree resolves them at launch. Nothing to copy into a new
worktree, and no `.env.local` to keep in sync across the ten worktrees an agent just made.

## Install

```bash
npm install -g envless   # not published yet; use `npm link` from a clone for now
```

Requires Node.js 24+ (the CLI runs TypeScript directly, so there is no build step).

## Use

Declare the environment in `envless.json` at the project root and commit it:

```json
{
  "env": {
    "API_URL": "https://api.example.com",
    "CLIENT_SECRET": "gcp://my-project/my-client-secret",
    "TENANT_SLUG": null
  }
}
```

| Value | Meaning |
|---|---|
| `"..."` | literal |
| `"{{ portless.url }}"` | the app's URL from [portless](https://portless.sh); `{{ portless.host }}` for the host. Usable inside a larger string |
| `"gcp://<project>/<secret>"` | Google Secret Manager, `latest` version (`#<version>` to pin) |
| `null` | required: must already be in the environment, otherwise envless refuses to start |

Then run anything through it:

```bash
envless run npm run dev
```

```
envless: /path/to/envless.json
  API_URL (literal)
  CLIENT_SECRET (secret)
  TENANT_SLUG (from environment)
```

The manifest is found by walking up from the working directory, so it works from any
subdirectory and in any linked worktree.

## With portless

`{{ portless.url }}` fills in the per-worktree URL that [portless](https://portless.sh)
assigns, so a variable like a public base URL or an OAuth callback needs no per-worktree
value anywhere:

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

Everything else keeps working in the wrong order, and a variable already in the
environment still wins, so `PUBLIC_URL=http://localhost:3000 envless run next dev` needs no
portless at all.

## Design

- **Values only ever reach the child process.** envless does not write files and has no
  command that prints a resolved value — not even a masked one. There is nothing to
  accidentally commit, cat, or leave behind in a worktree.
- **The environment wins.** A variable already set is used as-is and its secret is never
  fetched. That is the override mechanism and the offline escape hatch:
  `CLIENT_SECRET=xxx envless run npm run dev`.
- **Fail loudly, with the fix.** Missing credentials, missing permission, wrong secret
  name and mistyped reference schemes each say what to do. Agents get an actionable
  message instead of an app that boots with `gpc://…` as its password.
- **Secrets are fetched lazily.** A manifest with no `gcp://` references never loads the
  Secret Manager SDK and never needs credentials.
- **Local binaries just work.** The project's `node_modules/.bin` is put on the child's
  PATH, so `envless run next dev` works without an `npm run` in between.

## Not yet

- `{{ branch }}` / `{{ worktree }}` templates for per-worktree database names, bucket
  prefixes and the like
- Backends beyond GCP (1Password, AWS, Vault)
- Per-user overrides in a state dir outside the repo (`~/.envless/<project>/<worktree>`)
- Optional short-lived caching for offline starts

## Development

```bash
npm install
npm test        # node:test, no network
npm run typecheck
```
