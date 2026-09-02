#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { loadManifest, ManifestError } from "./manifest.ts";
import { resolveManifest, ResolveError, type Resolution } from "./resolve.ts";
import { gcpFetcher, SecretAccessError } from "./gcp.ts";

const USAGE = `envless - resolve environment variables from a committed manifest

Usage:
  envless run <command> [args...]   Run a command with the manifest's variables in its environment

Options:
  -h, --help      Show this help
  -v, --version   Show the version

Manifest (envless.json, found by walking up from the working directory):
  {
    "env": {
      "API_URL": "https://api.example.com",
      "CLIENT_SECRET": "gcp://my-project/my-secret",
      "TENANT": null
    }
  }

  string       literal value
  {{ ... }}    template: {{ portless.url }} / {{ portless.host }} from portless,
               {{ dataless.url }} from dataless
  gcp://...    Google Secret Manager: gcp://<project>/<secret>[#<version>] (default: latest)
  null         required: must already be present in the environment

Templates read what those tools put in the environment (PORTLESS_URL,
DATALESS_URL), so envless has to be the innermost command:

  portless run dataless run envless run next dev

Values are passed to the child process only. envless never writes them to disk
and has no command that prints them, so a .env file is not needed per worktree.
A variable already set in the environment wins and its secret is not fetched,
which is also the offline escape hatch:

  CLIENT_SECRET=xxx envless run npm run dev
`;

function version(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8")
  ) as { version: string };
  return pkg.version;
}

function logResolution(resolution: Resolution, manifestPath: string): void {
  // stderr so the child's stdout stays clean for pipes.
  console.error(`envless: ${manifestPath}`);
  for (const { key, origin } of resolution.report) {
    const note = origin === "environment" ? "from environment" : origin;
    console.error(`  ${key} (${note})`);
  }
}

async function run(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command) {
    console.error("envless: run needs a command\n");
    console.error(USAGE);
    return 1;
  }

  const manifest = loadManifest(process.cwd());
  const gcp = gcpFetcher();
  let resolution: Resolution;
  try {
    resolution = await resolveManifest(manifest, process.env, gcp.fetch, {
      portlessUrl: process.env.PORTLESS_URL,
      datalessUrl: process.env.DATALESS_URL,
    });
  } finally {
    await gcp.close();
  }
  logResolution(resolution, manifest.path);

  const child = spawn(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...binPath(manifest.path),
      ...Object.fromEntries(resolution.values),
    },
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }

  return await new Promise<number>((done, fail) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        console.error(`envless: command not found: ${command}`);
        done(127);
        return;
      }
      fail(err);
    });
    // A child killed by a signal has no exit code; report it as a failure.
    child.on("exit", (code, signal) => done(signal ? 1 : (code ?? 0)));
  });
}

/**
 * Put the project's `node_modules/.bin` on PATH so `envless run next dev` works
 * the way it does inside an npm script, without an `npm run` in between.
 */
function binPath(manifestPath: string): { PATH?: string } {
  const bin = join(dirname(manifestPath), "node_modules", ".bin");
  if (!existsSync(bin)) return {};
  const current = process.env.PATH ?? "";
  if (current.split(delimiter).includes(bin)) return {};
  return { PATH: current ? `${bin}${delimiter}${current}` : bin };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (!first || first === "-h" || first === "--help" || first === "help") {
    console.log(USAGE);
    return first ? 0 : 1;
  }
  if (first === "-v" || first === "--version") {
    console.log(version());
    return 0;
  }
  if (first === "run") {
    return await run(argv.slice(1));
  }

  console.error(`envless: unknown command ${JSON.stringify(first)}\n`);
  console.error(USAGE);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (
      err instanceof ManifestError ||
      err instanceof ResolveError ||
      err instanceof SecretAccessError
    ) {
      console.error(`envless: ${err.message}`);
    } else {
      console.error("envless:", err);
    }
    process.exit(1);
  });
