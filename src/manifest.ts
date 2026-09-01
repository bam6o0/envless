import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MANIFEST_NAME = "envless.json";

/** How a variable's value is obtained. */
export type Source =
  | { kind: "literal"; value: string }
  /** A literal with `{{ ... }}` placeholders, expanded at resolve time. */
  | { kind: "template"; template: string; placeholders: Placeholder[] }
  | { kind: "gcp"; project: string; secret: string; version: string }
  /** Declared but not sourced: must already be present in the environment. */
  | { kind: "required" };

export type Manifest = {
  /** Absolute path of the manifest file this was parsed from. */
  path: string;
  vars: Map<string, Source>;
};

/** Placeholders usable inside a value, as `{{ <name> }}`. */
export const PLACEHOLDERS = ["portless.url", "portless.host"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

// `gcp://<project>/<secret>` or `gcp://<project>/<secret>#<version>`
const GCP_REF = /^gcp:\/\/([\w-]+)\/([\w-]+)(?:#([\w-]+))?$/;

/** Schemes that mean "fetch this from somewhere" rather than "this is the value". */
const REFERENCE_SCHEMES = ["gcp"] as const;

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//;

/** The same letters in a different order, as `gpc` is for `gcp`. */
function isScrambled(scheme: string, reference: string): boolean {
  return (
    scheme !== reference &&
    scheme.length === reference.length &&
    [...scheme].sort().join("") === [...reference].sort().join("")
  );
}

// `{{ name }}`, tolerant of surrounding whitespace.
export const PLACEHOLDER_REF = /\{\{\s*([\w.]+)\s*\}\}/g;

class ManifestError extends Error {}

/** Walk up from `from` looking for envless.json. */
export function findManifest(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, MANIFEST_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function parseSource(key: string, raw: unknown): Source {
  if (raw === null) return { kind: "required" };
  if (typeof raw !== "string") {
    throw new ManifestError(
      `${key}: expected a string or null, got ${raw === undefined ? "undefined" : typeof raw}`
    );
  }
  const placeholders = [...raw.matchAll(PLACEHOLDER_REF)];
  if (placeholders.length > 0) {
    const names = placeholders.map((m) => m[1]!);
    const unknown = names.find(
      (name) => !(PLACEHOLDERS as readonly string[]).includes(name)
    );
    if (unknown) {
      throw new ManifestError(
        `${key}: unknown placeholder {{ ${unknown} }} (supported: ${PLACEHOLDERS.map((p) => `{{ ${p} }}`).join(", ")})`
      );
    }
    return {
      kind: "template",
      template: raw,
      placeholders: [...new Set(names)] as Placeholder[],
    };
  }

  const scheme = raw.match(SCHEME)?.[1];
  if (scheme === "gcp") {
    const gcp = raw.match(GCP_REF);
    if (!gcp) {
      throw new ManifestError(
        `${key}: malformed gcp:// reference in ${JSON.stringify(raw)} (expected gcp://<project>/<secret>[#<version>])`
      );
    }
    return {
      kind: "gcp",
      project: gcp[1]!,
      secret: gcp[2]!,
      version: gcp[3] ?? "latest",
    };
  }
  // Any other scheme is part of the value: connection strings (`postgresql://`,
  // `redis://`, `amqp://`) are what an app is configured with, not places to
  // fetch from. Only a scrambled spelling of a reference scheme is a typo worth
  // failing on — shipping "gpc://project/secret" to the app as a password is the
  // mistake this catches.
  const scrambled = scheme && REFERENCE_SCHEMES.find((r) => isScrambled(scheme, r));
  if (scrambled) {
    throw new ManifestError(
      `${key}: unknown reference scheme "${scheme}://" in ${JSON.stringify(raw)} — did you mean "${scrambled}://"?`
    );
  }
  return { kind: "literal", value: raw };
}

export function parseManifest(path: string, text: string): Manifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ManifestError(
      `${path}: invalid JSON (${err instanceof Error ? err.message : String(err)})`
    );
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ManifestError(`${path}: expected a JSON object at the top level`);
  }
  const env = (json as { env?: unknown }).env;
  if (env === undefined) {
    throw new ManifestError(`${path}: missing "env" object`);
  }
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new ManifestError(`${path}: "env" must be an object`);
  }

  const vars = new Map<string, Source>();
  for (const [key, raw] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ManifestError(`${path}: ${JSON.stringify(key)} is not a valid variable name`);
    }
    try {
      vars.set(key, parseSource(key, raw));
    } catch (err) {
      throw new ManifestError(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { path, vars };
}

export function loadManifest(from: string): Manifest {
  const path = findManifest(from);
  if (!path) {
    throw new ManifestError(
      `no ${MANIFEST_NAME} found (searched from ${resolve(from)} upwards)`
    );
  }
  return parseManifest(path, readFileSync(path, "utf-8"));
}

export { ManifestError };
