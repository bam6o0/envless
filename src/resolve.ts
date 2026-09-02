import { PLACEHOLDER_REF, type Manifest, type Placeholder, type Source } from "./manifest.ts";

/** Fetches one secret value. Injected so resolution is testable without network. */
export type SecretFetcher = (source: Extract<Source, { kind: "gcp" }>) => Promise<string>;

export type Resolution = {
  /** Values to add to the child environment. Never includes keys already set. */
  values: Map<string, string>;
  /** What happened per variable, in manifest order. For logging. */
  report: { key: string; origin: "environment" | "literal" | "secret" | "template" }[];
};

/**
 * Values available to `{{ ... }}` placeholders.
 *
 * Each one comes from a tool that envless runs *inside*: `PORTLESS_URL` from
 * portless, `DATALESS_URL` from dataless. The other order cannot work — those
 * tools pick a port or create a database when they spawn their child, so
 * envless has to be the innermost command.
 */
export type TemplateContext = {
  portlessUrl?: string | undefined;
  datalessUrl?: string | undefined;
};

/** Which tool supplies a placeholder, for the error when it is missing. */
const SUPPLIER: Record<Placeholder, { tool: string; variable: string }> = {
  "portless.url": { tool: "portless", variable: "PORTLESS_URL" },
  "portless.host": { tool: "portless", variable: "PORTLESS_URL" },
  "dataless.url": { tool: "dataless", variable: "DATALESS_URL" },
};

function placeholderValue(
  name: Placeholder,
  context: TemplateContext
): string | undefined {
  switch (name) {
    case "portless.url":
      return context.portlessUrl;
    case "portless.host":
      return context.portlessUrl ? new URL(context.portlessUrl).host : undefined;
    case "dataless.url":
      return context.datalessUrl;
  }
}

function expand(
  key: string,
  template: string,
  placeholders: Placeholder[],
  manifestPath: string,
  context: TemplateContext
): string {
  for (const name of placeholders) {
    if (placeholderValue(name, context) === undefined) {
      const { tool, variable } = SUPPLIER[name];
      throw new ResolveError(
        `${key} in ${manifestPath} uses {{ ${name} }} but ${variable} is not set\n` +
          `  run envless inside ${tool}: ${tool} run envless run <command>`
      );
    }
  }
  return template.replace(PLACEHOLDER_REF, (_match, name: string) =>
    placeholderValue(name as Placeholder, context)!
  );
}

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
  fetchSecret: SecretFetcher,
  context: TemplateContext = {}
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
      case "template":
        values.set(
          key,
          expand(key, source.template, source.placeholders, manifest.path, context)
        );
        report.push({ key, origin: "template" });
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
