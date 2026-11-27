/**
 * Node sync from a Virtualizor master: two nodes with the same name (a fresh slave still called
 * "localhost", like the master) must both show — not overwrite each other.
 *   npx tsx --test test/virtualizor-nodes.test.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { encrypt } from "../src/lib/crypto";
import { VirtualizorClient } from "../src/modules/provisioning/virtualizor";
import { syncVirtualizorNodes } from "../src/modules/provisioning/virtualizor-nodes";

const RUN = Date.now().toString(36);
let serverId = "";
after(async () => {
  if (serverId) await prisma.server.delete({ where: { id: serverId } }).catch(() => undefined);
  await prisma.$disconnect();
});

test("same-named nodes get their id added; the master keeps the plain name", async () => {
  const P = VirtualizorClient.prototype as any;
  let servs: Record<string, object> = {
    "0": { server_name: "localhost", ip: "10.0.0.1", numvps: 105, total_ram: 1000, ram: 550 },
    "9": { server_name: "srv10", ip: "10.0.0.9", numvps: 163, total_ram: 1000, ram: 200 },
  };
  P.servers = async () => ({ servs });
  P.serverLoads = async () => ({});
  P.serverUsage = async () => ({ usage: {} });
  const s = await prisma.server.create({ data: { name: `QA vz ${RUN}`, type: "VIRTUALIZOR", hostname: "vz.example.test", apiUser: "k", apiSecretEnc: encrypt("p") } as never });
  serverId = s.id;
  await syncVirtualizorNodes(s);
  // a new node added on the master, still named localhost
  servs = { ...servs, "12": { server_name: "localhost", ip: "10.0.0.12", numvps: 0, total_ram: 1000, ram: 950 } };
  await syncVirtualizorNodes(s);
  const rows = await prisma.serverNode.findMany({ where: { serverId }, orderBy: { name: "asc" } });
  assert.deepEqual(rows.map((r) => [r.name, r.externalId]), [["localhost", "0"], ["localhost #12", "12"], ["srv10", "9"]]);
  assert.equal((rows[0].meta as any).vpsCount, 105, "the master's row keeps the master's figures");
  // renamed in Virtualizor: the old row goes
  servs = { ...servs, "12": { server_name: "srv12", ip: "10.0.0.12" } };
  await syncVirtualizorNodes(s);
  assert.deepEqual((await prisma.serverNode.findMany({ where: { serverId }, orderBy: { name: "asc" } })).map((r) => r.name), ["localhost", "srv10", "srv12"]);
});
