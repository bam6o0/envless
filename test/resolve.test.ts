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
