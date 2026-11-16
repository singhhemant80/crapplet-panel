/**
 * Virtualizor power state parsing (the "Online / Offline" chip on service lists).
 *   npx tsx --test test/virtualizor-status.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualizorClient } from "../src/modules/provisioning/virtualizor";

const client = (reply: unknown) => {
  const c = new VirtualizorClient({ host: "v.example.test", port: 4085, apiKey: "k", apiPass: "p", verifyTls: false });
  (c as unknown as { call: () => Promise<unknown> }).call = async () => reply;
  return c;
};

test("keyed by vpsid, plain or as rows", async () => {
  assert.deepEqual(await client({ status: { "3226": 1, "3224": "0" } }).vpsStatus(["3226", "3224"]), { "3226": 1, "3224": 0 });
  assert.deepEqual(await client({ status: { "3226": { status: 1, used_bandwidth: 3 } } }).vpsStatus(["3226"]), { "3226": 1 });
  assert.deepEqual(await client({ status: { "3226": { stat: "2" } } }).vpsStatus(["3226"]), { "3226": 2 });
});

test("other shapes: a list of rows, words, vs_status key", async () => {
  assert.deepEqual(await client({ status: [{ vpsid: "7", status: 1 }, { vpsid: "8", status: 0 }] }).vpsStatus(["7", "8"]), { "7": 1, "8": 0 });
  assert.deepEqual(await client({ vs_status: { "9": { state: "running" } } }).vpsStatus(["9"]), { "9": 1 });
});

test("nothing usable → left out (so the list falls back to reading that VPS)", async () => {
  assert.deepEqual(await client({ status: { "3226": "" } }).vpsStatus(["3226"]), {});
  assert.deepEqual(await client({}).vpsStatus(["3226"]), {});
});
