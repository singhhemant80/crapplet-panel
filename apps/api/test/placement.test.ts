import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { encrypt } from "../src/lib/crypto";
import { chooseVirtualizorNode, parseExtraParams } from "../src/modules/provisioning/provisioner";

const RUN = Date.now().toString(36);
after(async () => {
  await prisma.server.deleteMany({ where: { name: `place-${RUN}` } });
  await prisma.$disconnect();
});

test("extra Virtualizor params parse key=value lines", () => {
  assert.deepEqual(parseExtraParams("vnc=1\n# comment\n nic_type = virtio \n\nbad line"), { vnc: "1", nic_type: "virtio" });
});

test("node placement: staff choice, fixed, least-loaded under limits, auto with server group", async () => {
  const srv = await prisma.server.create({ data: { name: `place-${RUN}`, type: "VIRTUALIZOR", hostname: "v.invalid", port: 4085, apiUser: "k", apiSecretEnc: encrypt("p"), maxRamPct: 90, maxDiskPct: 90, maxCpuPct: 85 } });
  const mk = (name: string, externalId: string, d: Partial<{ online: boolean; enabled: boolean; cpuPct: number; ramUsedMb: number; ramTotalMb: number; locked: boolean }>) =>
    prisma.serverNode.create({ data: { serverId: srv.id, name, externalId, online: d.online ?? true, enabled: d.enabled ?? true, cpuPct: d.cpuPct ?? 10, ramUsedMb: d.ramUsedMb ?? 0, ramTotalMb: d.ramTotalMb ?? 65536, diskUsedGb: 100, diskTotalGb: 1000, meta: { locked: d.locked ?? false } } });
  await mk("busy", "1", { ramUsedMb: 62000 }); // 95% RAM → over the 90% limit
  await mk("roomy", "2", { ramUsedMb: 20000 });
  await mk("emptiest-but-off", "3", { ramUsedMb: 1000, enabled: false });
  await mk("emptiest-but-locked", "4", { ramUsedMb: 1000, locked: true });
  await mk("half", "5", { ramUsedMb: 32000 });

  assert.deepEqual(await chooseVirtualizorNode({ node: "5" }, srv, { placement: "least_loaded" }), { serid: 5, reason: "node 5 chosen by staff" });
  assert.equal((await chooseVirtualizorNode({ node: null }, srv, { placement: "fixed", nodeIds: ["1"] })).serid, 1);
  assert.equal((await chooseVirtualizorNode({ node: null }, srv, { slaveServerId: 3 })).serid, 3, "legacy slaveServerId = fixed");
  assert.equal((await chooseVirtualizorNode({ node: null }, srv, { placement: "least_loaded" })).serid, 2, "most free RAM among usable nodes");
  assert.equal((await chooseVirtualizorNode({ node: null }, srv, { placement: "least_loaded", nodeIds: ["1", "5"] })).serid, 5, "only allowed nodes; busy one is over the limit");
  await assert.rejects(chooseVirtualizorNode({ node: null }, srv, { placement: "least_loaded", nodeIds: ["1"] }), /under the limits/);
  const auto = await chooseVirtualizorNode({ node: null }, srv, { placement: "auto", serverGroupId: 7 });
  assert.equal(auto.serid, undefined);
  assert.equal(auto.serverGroupId, 7);
});

test("Virtualizor pools map to the right subnet", async () => {
  const { poolCidr } = await import("../src/modules/provisioning/virtualizor-ips");
  assert.deepEqual(poolCidr("163.5.191.1", "255.255.255.0"), { cidr: "163.5.191.0/24", prefix: 24 });
  assert.deepEqual(poolCidr("10.0.0.65", "255.255.255.192"), { cidr: "10.0.0.64/26", prefix: 26 });
  assert.deepEqual(poolCidr("10.0.0.1", "28"), { cidr: "10.0.0.0/28", prefix: 28 });
});

