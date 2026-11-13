import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../public-worker/index.ts", import.meta.url), "utf8");
const config = JSON.parse(await readFile(new URL("../wrangler.public.jsonc", import.meta.url), "utf8"));

test("public MCP worker supports standard initialization without OAuth", () => {
  assert.match(worker, /method === "initialize"/);
  assert.match(worker, /notifications\/initialized/);
  assert.match(worker, /tools\/list/);
  assert.match(worker, /tools\/call/);
  assert.match(worker, /access-control-allow-origin/);
  assert.doesNotMatch(worker, /WWW-Authenticate|oauth|openid/i);
});

test("public MCP worker persists matches in a Durable Object", () => {
  assert.equal(config.name, "signal-relay-public-mcp");
  assert.equal(config.durable_objects.bindings[0].class_name, "GameHub");
  assert.deepEqual(config.migrations[0].new_sqlite_classes, ["GameHub"]);
  assert.match(worker, /state\.storage\.put/);
  assert.match(worker, /state\.storage\.get/);
});

test("agent tokens are never exposed in public match state", () => {
  assert.match(worker, /\{ token: _token, \.\.\.player \}/);
  assert.match(worker, /entry\.token === playerToken/);
});
