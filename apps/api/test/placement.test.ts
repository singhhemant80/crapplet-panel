import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { encrypt } from "../src/lib/crypto";
import { chooseVirtualizorNode, parseExtraParams, virtualizorNodeCandidates } from "../src/modules/provisioning/provisioner";
import { parseStorages, pickStorage } from "../src/modules/provisioning/virtualizor";

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
  const mk = (name: string, externalId: string, d: Partial<{ online: boolean; enabled: boolean; cpuPct: number; ramUsedMb: number; ramTotalMb: number; locked: boolean; sgid: string; virt: string }>) =>
    prisma.serverNode.create({ data: { serverId: srv.id, name, externalId, online: d.online ?? true, enabled: d.enabled ?? true, cpuPct: d.cpuPct ?? 10, ramUsedMb: d.ramUsedMb ?? 0, ramTotalMb: d.ramTotalMb ?? 65536, diskUsedGb: 100, diskTotalGb: 1000, meta: { locked: d.locked ?? false, sgid: d.sgid ?? "0", virt: d.virt ?? "proxk" } } });
  await mk("busy", "1", { ramUsedMb: 62000 }); // 95% RAM → over the 90% limit
  await mk("roomy", "2", { ramUsedMb: 20000 });
  await mk("emptiest-but-off", "3", { ramUsedMb: 1000, enabled: false });
  await mk("emptiest-but-locked", "4", { ramUsedMb: 1000, locked: true });
  await mk("half", "5", { ramUsedMb: 32000, sgid: "7" });
  await mk("half-openvz", "6", { ramUsedMb: 30000, sgid: "7", virt: "vzo" });

  assert.deepEqual(await chooseVirtualizorNode({ node: "5" }, srv, { placement: "least_loaded" }), { serid: 5, reason: "node 5 chosen by staff" });
  assert.equal((await chooseVirtualizorNode({ node: null }, srv, { placement: "fixed", nodeIds: ["1"] })).serid, 1);
  assert.equal((await chooseVirtualizorNode({ node: null }, srv, { slaveServerId: 3 })).serid, 3, "legacy slaveServerId = fixed");
  assert.equal((await chooseVirtualizorNode({ node: null }, srv, { placement: "least_loaded" })).serid, 2, "most free RAM among usable nodes");
  assert.equal((await chooseVirtualizorNode({ node: null }, srv, { placement: "least_loaded", nodeIds: ["1", "5"] })).serid, 5, "only allowed nodes; busy one is over the limit");
  await assert.rejects(chooseVirtualizorNode({ node: null }, srv, { placement: "least_loaded", nodeIds: ["1"] }), /under the limits/);
  // auto: the panel picks the node itself (Virtualizor's node_select fails with "no_storage" on many masters)
  assert.equal((await chooseVirtualizorNode({ node: null }, srv, { placement: "auto" }, [], "proxk")).serid, 2, "auto = most free RAM");
  assert.equal((await chooseVirtualizorNode({ node: null }, srv, { placement: "auto", serverGroupId: 7 }, [], "proxk")).serid, 5, "auto stays inside the server group and skips other virt types");
  const all = await virtualizorNodeCandidates({ node: null }, srv, { placement: "auto" }, [], "proxk");
  assert.deepEqual(all.map((n) => n.serid), [2, 5], "fallback order for a node without storage");
});

test("Virtualizor pools map to the right subnet", async () => {
  const { poolCidr } = await import("../src/modules/provisioning/virtualizor-ips");
  assert.deepEqual(poolCidr("163.5.191.1", "255.255.255.0"), { cidr: "163.5.191.0/24", prefix: 24 });
  assert.deepEqual(poolCidr("10.0.0.65", "255.255.255.192"), { cidr: "10.0.0.64/26", prefix: 26 });
  assert.deepEqual(poolCidr("10.0.0.1", "28"), { cidr: "10.0.0.0/28", prefix: 28 });
});


test("storage choice: node's primary storage with room, else the roomiest attached one", () => {
  const st = parseStorages({
    storage: {
      "1": { stid: "1", name: "nvme-node2", type: "lvm", primary_storage: "1", serid: "2", size: "1800", free: "1500" },
      "2": { stid: "2", name: "small-primary-node5", primary_storage: "1", serid: "5", size: "100", free: "10" },
      "3": { stid: "3", name: "big-node5", primary_storage: "0", serid: "5", size: "4000", free: "3000" },
      "4": { stid: "4", name: "shared-ceph", primary_storage: "0", servers: { "2": "2", "5": "5" }, free: "500" },
    },
  });
  assert.deepEqual(st.find((s) => s.stid === 4)?.serids, ["2", "5"]);
  assert.equal(pickStorage(st, "2", 50)?.stid, 1);
  assert.equal(pickStorage(st, "5", 50)?.stid, 3, "primary too small → biggest attached storage");
  assert.equal(pickStorage(st, "9", 50), null, "nothing attached to node 9");
});

test("storage is only sent when the master ties it to the node (else the node's primary is used)", () => {
  // shape many masters return: no node mapping at all
  const unmapped = parseStorages({ storage: { "1": { stid: "1", st_uuid: "abc123", name: "local", primary_storage: "1", free: "900" } } });
  assert.equal(unmapped[0].uuid, "abc123");
  assert.equal(pickStorage(unmapped, "2", 40), null, "unknown mapping → send no storage");
  // attached through a server group
  const grouped = parseStorages({ storage: { "7": { stid: "7", name: "ceph", primary_storage: "1", sgid: "3", free: "5000" } } });
  assert.equal(pickStorage(grouped, "2", 40, "3")?.stid, 7);
  assert.equal(pickStorage(grouped, "2", 40, "4"), null);
});

test("storage-type refusals from Virtualizor are recognised", async () => {
  const { isStorageError } = await import("../src/modules/provisioning/provisioner");
  for (const m of ['Virtualizor addvs: ["The storage you submitted is invalid"]', 'Virtualizor addvs: {"no_storage":"The primary storage could not be found"}', "Virtualizor addvs: not enough space"])
    assert.ok(isStorageError(new Error(m)), m);
  assert.ok(!isStorageError(new Error('Virtualizor addvs: {"osid":"Invalid OS"}')));
});

test("storage rows are found in the shapes masters use (grouped per node, arrays, other keys)", () => {
  const grouped = parseStorages({ storage: { "2": { "5": { stid: "5", name: "thin-2", primary_storage: "1", free: "900" } }, "0": { "6": { stid: "6", name: "thin-0", free: "800" } } } });
  assert.deepEqual(grouped.map((x) => [x.stid, x.serids]).sort((a, b) => (a[0] as number) - (b[0] as number)), [[5, ["2"]], [6, ["0"]]]);
  assert.equal(pickStorage(grouped, "2", 40)?.stid, 5);
  const arr = parseStorages({ storages: [{ stid: 9, st_uuid: "u9", name: "zfs", primary_storage: 1, serid: "3" }] });
  assert.deepEqual([arr[0].stid, arr[0].uuid, arr[0].primary, arr[0].serids], [9, "u9", true, ["3"]]);
  const other = parseStorages({ title: "Create VPS", server_storage: { "4": { stid: "4", name: "lvm" } } });
  assert.equal(other[0]?.stid, 4);
  assert.deepEqual(parseStorages({ title: "Create VPS", plans: { "1": { plid: "1" } } }), []);
});

test("storage used by an existing VPS is found in its details/edit form", async () => {
  const { collectStorageRefs } = await import("../src/modules/provisioning/virtualizor");
  const acc = { uuids: [] as string[], stids: [] as number[], diskShapes: [] as Record<string, unknown>[] };
  collectStorageRefs({ title: "Edit VPS", vps: { vpsid: "3097", virt: "proxk" }, disks: { "0": { did: "1", st_uuid: "abc", size: "120" }, "1": { stid: "29", size: "20" } } }, acc);
  assert.deepEqual(acc.uuids, ["abc"]);
  assert.deepEqual(acc.stids, [29]);
  assert.equal(acc.diskShapes.length, 2);
});
