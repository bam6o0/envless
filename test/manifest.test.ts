import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findManifest, parseManifest, parseSource, ManifestError } from "../src/manifest.ts";

test("parseSource: literal", () => {
  assert.deepEqual(parseSource("A", "hello"), { kind: "literal", value: "hello" });
  assert.deepEqual(parseSource("A", "https://api.example.com"), {
    kind: "literal",
    value: "https://api.example.com",
  });
});

test("parseSource: gcp reference", () => {
  assert.deepEqual(parseSource("A", "gcp://proj-1/my-secret"), {
    kind: "gcp",
    project: "proj-1",
    secret: "my-secret",
    version: "latest",
  });
  assert.deepEqual(parseSource("A", "gcp://proj-1/my-secret#3"), {
    kind: "gcp",
    project: "proj-1",
    secret: "my-secret",
    version: "3",
  });
});

test("parseSource: null means required", () => {
  assert.deepEqual(parseSource("A", null), { kind: "required" });
});

test("parseSource: a mistyped scheme is an error, not a literal password", () => {
  assert.throws(() => parseSource("A", "gpc://proj/secret"), ManifestError);
  assert.throws(() => parseSource("A", "gcp://proj"), ManifestError);
});

test("parseSource: non-string is an error", () => {
  assert.throws(() => parseSource("A", 42), ManifestError);
  assert.throws(() => parseSource("A", { gcp: "x" }), ManifestError);
});

test("parseManifest: reads the env object", () => {
  const manifest = parseManifest(
    "/tmp/envless.json",
    JSON.stringify({ env: { A: "1", B: "gcp://p/s", C: null } })
  );
  assert.deepEqual([...manifest.vars.keys()], ["A", "B", "C"]);
  assert.equal(manifest.path, "/tmp/envless.json");
});

test("parseManifest: rejects malformed manifests", () => {
  assert.throws(() => parseManifest("m", "{"), ManifestError);
  assert.throws(() => parseManifest("m", "[]"), ManifestError);
  assert.throws(() => parseManifest("m", "{}"), ManifestError);
  assert.throws(() => parseManifest("m", '{"env": []}'), ManifestError);
  assert.throws(() => parseManifest("m", '{"env": {"not a name": "1"}}'), ManifestError);
});

test("findManifest: walks up from a nested directory", () => {
  const root = mkdtempSync(join(tmpdir(), "envless-test-"));
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, "envless.json"), '{"env":{}}');

  assert.equal(findManifest(nested), join(root, "envless.json"));
  assert.equal(findManifest(root), join(root, "envless.json"));
});

test("findManifest: undefined when there is none", () => {
  const root = mkdtempSync(join(tmpdir(), "envless-test-"));
  // A manifest somewhere above tmpdir would break this, which is exactly the
  // lookup behaviour under test; tmpdir has none in practice.
  assert.equal(findManifest(root), undefined);
});

test("parseSource: templates", () => {
  assert.deepEqual(parseSource("A", "{{ portless.url }}"), {
    kind: "template",
    template: "{{ portless.url }}",
    placeholders: ["portless.url"],
  });
  // embedded in a larger string, and whitespace-tolerant
  assert.deepEqual(parseSource("A", "https://{{portless.host}}/callback"), {
    kind: "template",
    template: "https://{{portless.host}}/callback",
    placeholders: ["portless.host"],
  });
  // repeated placeholders are deduped
  assert.deepEqual(
    parseSource("A", "{{ portless.url }} {{ portless.url }}"),
    {
      kind: "template",
      template: "{{ portless.url }} {{ portless.url }}",
      placeholders: ["portless.url"],
    }
  );
});

test("parseSource: unknown placeholder is an error", () => {
  assert.throws(() => parseSource("A", "{{ portless.uri }}"), ManifestError);
  assert.throws(() => parseSource("A", "{{ branch }}"), ManifestError);
});
