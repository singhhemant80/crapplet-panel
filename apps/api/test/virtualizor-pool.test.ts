/**
 * Virtualizor connection pool: many parallel API calls share a few kept-alive connections,
 * instead of opening one connection per call (which flood protection in front of a master blocks).
 *   npx tsx --test test/virtualizor-pool.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { VirtualizorClient } from "../src/modules/provisioning/virtualizor";

test("parallel Virtualizor calls reuse at most 4 connections per master", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vz-pool-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`], { stdio: "ignore" });
  let connections = 0;
  let requests = 0;
  const server = https.createServer({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) }, (_req, res) => {
    requests++;
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: 1 }));
    }, 20);
  });
  server.on("secureConnection", () => connections++);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const creds = { host: "127.0.0.1", port, apiKey: "k", apiPass: "p", verifyTls: false };
    // a new client object per call, as the panel's code does
    const results = await Promise.all(Array.from({ length: 40 }, () => new VirtualizorClient(creds).call("serverloads")));
    assert.equal(results.length, 40);
    assert.equal(requests, 40);
    assert.ok(connections <= 4, `40 calls used ${connections} connections`);
    // later calls keep using the same connections
    await Promise.all(Array.from({ length: 10 }, () => new VirtualizorClient(creds).call("serverloads")));
    assert.ok(connections <= 4, `50 calls used ${connections} connections`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
