import { test } from "node:test";
import assert from "node:assert/strict";
import { parseManifest } from "../src/manifest.ts";
import { resolveManifest, ResolveError, type SecretFetcher } from "../src/resolve.ts";

const manifest = (env: Record<string, unknown>) =>
  parseManifest("/tmp/envless.json", JSON.stringify({ env }));

const fetcher = (calls: string[]): SecretFetcher => async (source) => {
  calls.push(`${source.project}/${source.secret}#${source.version}`);
  return `value-of-${source.secret}`;
};

test("resolves literals and secrets", async () => {
  const calls: string[] = [];
  const { values, report } = await resolveManifest(
    manifest({ A: "1", S: "gcp://p/s" }),
    {},
    fetcher(calls)
  );

  assert.deepEqual([...values], [["A", "1"], ["S", "value-of-s"]]);
  assert.deepEqual(calls, ["p/s#latest"]);
  assert.deepEqual(report, [
    { key: "A", origin: "literal" },
    { key: "S", origin: "secret" },
  ]);
});

test("an existing environment variable wins and its secret is not fetched", async () => {
  const calls: string[] = [];
  const { values, report } = await resolveManifest(
    manifest({ A: "from-manifest", S: "gcp://p/s" }),
    { A: "from-env", S: "secret-from-env" },
    fetcher(calls)
  );

  assert.deepEqual([...values], []);
  assert.deepEqual(calls, []);
  assert.deepEqual(report, [
    { key: "A", origin: "environment" },
    { key: "S", origin: "environment" },
  ]);
});

test("an empty environment variable is not treated as set", async () => {
  const { values } = await resolveManifest(manifest({ A: "1" }), { A: "" }, fetcher([]));
  assert.deepEqual([...values], [["A", "1"]]);
});

test("required variables must come from the environment", async () => {
  await assert.rejects(
    () => resolveManifest(manifest({ T: null }), {}, fetcher([])),
    (err: unknown) => err instanceof ResolveError && /T is declared as required/.test(String(err))
  );

  const { values, report } = await resolveManifest(
    manifest({ T: null }),
    { T: "tenant-a" },
    fetcher([])
  );
  assert.deepEqual([...values], []);
  assert.deepEqual(report, [{ key: "T", origin: "environment" }]);
});

test("a failing secret fetch propagates", async () => {
  await assert.rejects(
    () =>
      resolveManifest(manifest({ S: "gcp://p/s" }), {}, async () => {
        throw new Error("boom");
      }),
    /boom/
  );
});

test("expands portless placeholders", async () => {
  const { values, report } = await resolveManifest(
    manifest({
      URL: "{{ portless.url }}",
      CALLBACK: "{{ portless.url }}/api/auth/callback",
      HOST: "{{ portless.host }}",
    }),
    {},
    fetcher([]),
    { portlessUrl: "https://feature-x.myapp.localhost" }
  );

  assert.deepEqual(
    [...values],
    [
      ["URL", "https://feature-x.myapp.localhost"],
      ["CALLBACK", "https://feature-x.myapp.localhost/api/auth/callback"],
      ["HOST", "feature-x.myapp.localhost"],
    ]
  );
  assert.deepEqual(report.map((r) => r.origin), ["template", "template", "template"]);
});

test("portless.host keeps a non-default port", async () => {
  const { values } = await resolveManifest(
    manifest({ HOST: "{{ portless.host }}" }),
    {},
    fetcher([]),
    { portlessUrl: "http://myapp.localhost:8080" }
  );
  assert.equal(values.get("HOST"), "myapp.localhost:8080");
});

test("a template without PORTLESS_URL explains the required order", async () => {
  await assert.rejects(
    () => resolveManifest(manifest({ URL: "{{ portless.url }}" }), {}, fetcher([])),
    (err: unknown) =>
      err instanceof ResolveError &&
      /PORTLESS_URL is not set/.test(String(err)) &&
      /portless run envless run/.test(String(err))
  );
});

test("expands the dataless placeholder", async () => {
  const { values, report } = await resolveManifest(
    manifest({ DATABASE_URL: "{{ dataless.url }}" }),
    {},
    fetcher([]),
    { datalessUrl: "postgresql://postgres@localhost:5432/myapp_feature_x" }
  );
  assert.equal(
    values.get("DATABASE_URL"),
    "postgresql://postgres@localhost:5432/myapp_feature_x"
  );
  assert.deepEqual(report.map((r) => r.origin), ["template"]);
});

test("each placeholder names the tool that supplies it", async () => {
  await assert.rejects(
    () => resolveManifest(manifest({ DATABASE_URL: "{{ dataless.url }}" }), {}, fetcher([])),
    (err: unknown) =>
      err instanceof ResolveError &&
      /DATALESS_URL is not set/.test(String(err)) &&
      /dataless run envless run/.test(String(err))
  );
});

test("placeholders from different tools resolve independently", async () => {
  const { values } = await resolveManifest(
    manifest({ URL: "{{ portless.url }}", DATABASE_URL: "{{ dataless.url }}" }),
    {},
    fetcher([]),
    {
      portlessUrl: "https://feature-x.myapp.localhost",
      datalessUrl: "postgresql://postgres@localhost:5432/myapp_feature_x",
    }
  );
  assert.equal(values.get("URL"), "https://feature-x.myapp.localhost");
  assert.equal(values.get("DATABASE_URL"), "postgresql://postgres@localhost:5432/myapp_feature_x");
});

test("an environment value wins over a template, so no portless is needed", async () => {
  const { values, report } = await resolveManifest(
    manifest({ URL: "{{ portless.url }}" }),
    { URL: "http://localhost:3000" },
    fetcher([])
  );
  assert.deepEqual([...values], []);
  assert.deepEqual(report, [{ key: "URL", origin: "environment" }]);
});
