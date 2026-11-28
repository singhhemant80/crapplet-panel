/**
 * The guard in front of every Virtualizor master: rate limit, shared answers for reads,
 * back-off while the master isn't answering.
 *   npx tsx --test test/virtualizor-guard.test.ts
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { guarded, isRead, MAX_RPS, resetGuard } from "../src/modules/provisioning/virtualizor-guard";

beforeEach(() => resetGuard());
const K = "vz.example.test|key";

test("reads vs changes", () => {
  assert.equal(isRead("vs", { vpsid: 5 }, undefined), true);
  assert.equal(isRead("vs", { suspend: 5 }, undefined), false);
  assert.equal(isRead("vs", { action: "start", vpsid: 5 }, undefined), false);
  assert.equal(isRead("managevps", { vpsid: 5 }, { editvps: 1 }), false);
  assert.equal(isRead("vnc", { svs: 5 }, undefined), false, "console tokens are never reused");
});

test("the same read at the same time is one request; repeats within the TTL are free", async () => {
  let sent = 0;
  const run = async () => { sent++; await new Promise((r) => setTimeout(r, 30)); return { vs: { "5": { vpsid: "5" } } }; };
  const all = await Promise.all(Array.from({ length: 20 }, () => guarded(K, "vs", { vpsid: 5 }, undefined, run)));
  assert.equal(sent, 1);
  assert.equal(all.length, 20);
  all[0].vs["5"].vpsid = "changed";
  assert.equal(all[1].vs["5"].vpsid, "5", "each caller gets its own copy");
  await guarded(K, "vs", { vpsid: 5 }, undefined, run);
  assert.equal(sent, 1, "served from the recent answer");
  await guarded(K, "vs", { vpsid: 5 }, undefined, run, true);
  assert.equal(sent, 2, "fresh asks again");
  // a change clears the kept answers
  await guarded(K, "vs", { action: "stop", vpsid: 5 }, undefined, async () => ({ done: 1 }));
  await guarded(K, "vs", { vpsid: 5 }, undefined, run);
  assert.equal(sent, 3);
});

test("rate limit: a burst of different calls is spread out", async () => {
  const t0 = Date.now();
  const n = Math.round(MAX_RPS * 2) + Math.round(MAX_RPS * 2); // burst + 2 s worth
  await Promise.all(Array.from({ length: n }, (_, i) => guarded(K, "vs", { vpsid: i }, undefined, async () => ({}))));
  const took = Date.now() - t0;
  assert.ok(took >= 1500, `took ${took} ms — should be ~2 s at ${MAX_RPS}/s`);
});

test("master not answering: reads pause and fall back to the last answer; changes still go", async () => {
  let up = true;
  let sent = 0;
  const run = async () => { sent++; if (!up) throw new Error("Virtualizor at vz:4085 timed out"); return { servs: { "0": {} } }; };
  await guarded(K, "servers", { page: 1 }, undefined, run);
  up = false;
  // three failures in a row (different reads) start the pause
  for (const p of [2, 3, 4]) await assert.rejects(guarded(K, "servers", { page: p }, undefined, run));
  const before = sent;
  // the cached read: served from the last answer, nothing sent
  await guarded(K, "servers", { page: 1 }, undefined, run, true);
  assert.equal(sent, before);
  // an uncached read while paused: refused without contacting the master
  await assert.rejects(guarded(K, "servers", { page: 9 }, undefined, run), /recover/);
  assert.equal(sent, before);
  // a change customers asked for still goes out
  up = true;
  await guarded(K, "vs", { action: "start", vpsid: 1 }, undefined, async () => { sent++; return { done: 1 }; });
  assert.equal(sent, before + 1);
});
