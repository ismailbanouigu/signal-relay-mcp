import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"));

test("exposes a real MCP 2026-07-28 tool server", () => {
  assert.match(worker, /server\/discover/);
  assert.match(worker, /tools\/list/);
  assert.match(worker, /tools\/call/);
  assert.match(worker, /2026-07-28/);
  for (const name of ["create_match", "join_match", "inspect_match", "submit_move", "advance_round"]) {
    assert.match(worker, new RegExp('name: "' + name + '"'));
  }
});

test("persists multiplayer matches in D1", () => {
  assert.equal(manifest.d1, "DB");
  assert.deepEqual(manifest.capabilities, ["mcp"]);
  assert.match(worker, /INSERT INTO matches/);
  assert.match(worker, /INSERT INTO players/);
  assert.match(worker, /INSERT INTO moves/);
});

test("credits Pollinations without committing a secret key", () => {
  assert.match(page, /gen\.pollinations\.ai\/v1\/chat\/completions/);
  assert.match(page, /Made with pollinations\.ai/);
  assert.doesNotMatch(worker + page, /sk_[A-Za-z0-9_-]{8,}/);
});
