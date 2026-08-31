import type { Manifest, Source } from "./manifest.ts";

/** Fetches one secret value. Injected so resolution is testable without network. */
export type SecretFetcher = (source: Extract<Source, { kind: "gcp" }>) => Promise<string>;

export type Resolution = {
  /** Values to add to the child environment. Never includes keys already set. */
  values: Map<string, string>;
  /** What happened per variable, in manifest order. For logging. */
  report: { key: string; origin: "environment" | "literal" | "secret" }[];
};

export class ResolveError extends Error {}

/**
 * Resolve every variable in the manifest.
 *
 * Variables already present in `env` are left alone: an explicit
 * `FOO=bar envless run ...` wins, and no secret is fetched for it.
 */
export async function resolveManifest(
  manifest: Manifest,
  env: Record<string, string | undefined>,
  fetchSecret: SecretFetcher
): Promise<Resolution> {
  const values = new Map<string, string>();
  const report: Resolution["report"] = [];
  const missing: string[] = [];
  const pending: { key: string; source: Extract<Source, { kind: "gcp" }> }[] = [];

  for (const [key, source] of manifest.vars) {
    if (env[key]) {
      report.push({ key, origin: "environment" });
      continue;
    }
    switch (source.kind) {
      case "literal":
        values.set(key, source.value);
        report.push({ key, origin: "literal" });
        break;
      case "gcp":
        pending.push({ key, source });
        report.push({ key, origin: "secret" });
        break;
      case "required":
        missing.push(key);
        break;
    }
  }

  if (missing.length > 0) {
    throw new ResolveError(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} declared as required in ${manifest.path} ` +
        "but not set in the environment"
    );
  }

  await Promise.all(
    pending.map(async ({ key, source }) => {
      values.set(key, await fetchSecret(source));
    })
  );

  return { values, report };
}
