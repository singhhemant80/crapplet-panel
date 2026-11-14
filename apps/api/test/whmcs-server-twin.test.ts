/**
 * Services imported from WHMCS sit on "<name> (WHMCS)" — a copy of a Virtualizor master already set up
 * here, without its OS templates. Setup must build on the real master (or link the VPS the customer
 * already has), and staff can merge the copy away.
 *   npx tsx --test test/whmcs-server-twin.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { encrypt } from "../src/lib/crypto";
import { VirtualizorClient } from "../src/modules/provisioning/virtualizor";
import { runProvisionAction } from "../src/modules/provisioning/provisioner";
import { mergeServer, normHost, sameMaster } from "../src/modules/provisioning/server-twins";
import { closeQueues } from "../src/jobs/queues";

const RUN = Date.now().toString(36);
const HOST = `virt-${RUN}.invalid`;
const ids: Record<string, string> = {};
const created: Record<string, unknown>[] = [];
let existing: { vpsid: string; hostname: string; serid: string | null; createdAt: number | null; email: string | null }[] = [];

before(async () => {
  ids.real = (await prisma.server.create({ data: { name: `Real master ${RUN}`, type: "VIRTUALIZOR", hostname: HOST, port: 4085, apiUser: "k", apiSecretEnc: encrypt("p") } })).id;
  ids.copy = (await prisma.server.create({ data: { name: `srv ${RUN} (WHMCS)`, type: "VIRTUALIZOR", hostname: `https://${HOST.toUpperCase()}:4085/`, apiUser: "k", apiSecretEnc: encrypt("p"), enabled: false } })).id;
  await prisma.legacyMap.create({ data: { source: "whmcs", entity: "server", legacyId: `srv-${RUN}`, localId: ids.copy } });
  // the order's OS was synced from the WHMCS copy at some point; the real master has the same image under its own id
  ids.osCopy = (await prisma.osTemplate.create({ data: { name: "Windows Server 2022", remoteName: `win2022-${RUN}`, family: "windows", source: "virtualizor", virtualizorServerId: ids.copy, virtualizorOsId: 70001 } })).id;
  ids.osReal = (await prisma.osTemplate.create({ data: { name: "Windows Server 2022", remoteName: `win2022-${RUN}`, family: "windows", source: "virtualizor", virtualizorServerId: ids.real, virtualizorOsId: 80001 } })).id;
  const g = await prisma.productGroup.create({ data: { name: `QA twin ${RUN}`, slug: `qa-twin-${RUN}` } });
  ids.group = g.id;
  ids.product = (await prisma.product.create({ data: { groupId: g.id, name: `QA Win ${RUN}`, slug: `qa-win-${RUN}`, type: "VPS_WINDOWS", provisioner: "VIRTUALIZOR", autoSetup: "MANUAL", moduleConfig: { virtualizor: { virt: "kvm" } } } })).id;
  await prisma.productServer.create({ data: { productId: ids.product, serverId: ids.copy } });
  await prisma.productOs.create({ data: { productId: ids.product, osTemplateId: ids.osCopy } });
  ids.user = (await prisma.user.create({ data: { email: `jayesh-${RUN}@t.test`, passwordHash: "x", firstName: "Jayesh", lastName: "A", type: "CLIENT", status: "ACTIVE" } })).id;

  const proto = VirtualizorClient.prototype as unknown as Record<string, unknown>;
  proto.call = async () => { throw new Error("unreachable in tests"); };
  proto.findVpsByHostname = async (h: string) => existing.filter((v) => v.hostname === h);
  proto.createVps = async (p: Record<string, unknown>) => { created.push(p); return String(90000 + created.length); };
  proto.vpsIps = async () => ["198.18.7.7"];
  proto.storages = async () => [];
});

after(async () => {
  const sv = await prisma.service.findMany({ where: { userId: ids.user }, select: { id: true } });
  await prisma.provisioningLog.deleteMany({ where: { serviceId: { in: sv.map((s) => s.id) } } });
  await prisma.ipAddress.deleteMany({ where: { serviceId: { in: sv.map((s) => s.id) } } });
  await prisma.ipAddress.deleteMany({ where: { address: { startsWith: `198.18.${RUN.length}.` } } }).catch(() => undefined);
  await prisma.legacyMap.deleteMany({ where: { OR: [{ legacyId: { contains: RUN } }, { localId: { in: sv.map((s) => s.id) } }] } });
  await prisma.emailLog?.deleteMany?.({ where: { userId: ids.user } }).catch(() => undefined);
  await prisma.service.deleteMany({ where: { userId: ids.user } });
  await prisma.order.deleteMany({ where: { userId: ids.user } }).catch(() => undefined);
  await prisma.product.deleteMany({ where: { id: ids.product } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  await prisma.osTemplate.deleteMany({ where: { remoteName: `win2022-${RUN}` } });
  await prisma.server.deleteMany({ where: { id: { in: [ids.copy, ids.real] } } });
  await prisma.user.deleteMany({ where: { id: ids.user } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

const newService = async (hostname: string, imported: boolean) => {
  const s = await prisma.service.create({ data: { userId: ids.user, productId: ids.product, serverId: ids.copy, osTemplateId: ids.osCopy, hostname, status: "FAILED", billingCycle: "MONTHLY", firstAmount: 99900, recurringAmount: 99900, currency: "INR" } });
  if (imported) await prisma.legacyMap.create({ data: { source: "whmcs", entity: "service", legacyId: `svc-${hostname}`, localId: s.id } });
  return s.id;
};
const logs = async (id: string) => (await prisma.provisioningLog.findMany({ where: { serviceId: id }, orderBy: { createdAt: "asc" } })).map((l) => l.message).join("\n");

test("same master is recognised whatever way the hostname was written", async () => {
  assert.equal(normHost("https://Srv.Example.IN:4085/index.php"), "srv.example.in");
  assert.ok(await sameMaster({ type: "VIRTUALIZOR", hostname: "https://SRV.example.in:4085/" }, { type: "VIRTUALIZOR", hostname: "srv.example.in" }));
  assert.ok(await sameMaster({ type: "VIRTUALIZOR", hostname: "203.0.113.5" }, { type: "VIRTUALIZOR", hostname: "203.0.113.5:4085" }));
  assert.ok(!(await sameMaster({ type: "VIRTUALIZOR", hostname: "srv.example.in" }, { type: "CPANEL", hostname: "srv.example.in" })), "different kinds never match");
  assert.ok(!(await sameMaster({ type: "VIRTUALIZOR", hostname: "a.invalid" }, { type: "VIRTUALIZOR", hostname: "b.invalid" })));
});

test("a service on the WHMCS copy is built on the real master, with the real master's id for the same OS image", async () => {
  const id = await newService(`win-${RUN}.example`, false);
  await runProvisionAction(id, "create");
  const s = await prisma.service.findUniqueOrThrow({ where: { id } });
  assert.equal(s.status, "ACTIVE");
  assert.equal(s.serverId, ids.real, "moved to the real master");
  assert.equal(s.remoteId, String(90000 + created.length));
  assert.equal(created.at(-1)!.osId, 80001, "the real master's OS id, not the copy's");
  assert.equal(s.username, "Administrator");
  assert.match(await logs(id), /same Virtualizor master as "Real master/);
});

test("an imported service whose VPS already exists is linked to it — no second VPS, no welcome email with a made-up password", async () => {
  const host = `jayeshvps-${RUN}`;
  const id = await newService(host, true);
  existing = [
    { vpsid: "4242", hostname: host, serid: "3", createdAt: null, email: `JAYESH-${RUN}@t.test` },
    { vpsid: "4243", hostname: host, serid: "3", createdAt: null, email: "someone-else@t.test" },
  ];
  const before = created.length;
  const r = (await runProvisionAction(id, "create")) as { ok: boolean };
  assert.ok(r.ok);
  assert.equal(created.length, before, "nothing was built");
  const s = await prisma.service.findUniqueOrThrow({ where: { id } });
  assert.equal(s.remoteId, "4242", "the customer's own VPS (same email), not someone else's with the same hostname");
  assert.equal(s.serverId, ids.real);
  assert.equal(s.status, "ACTIVE");
  assert.equal(s.passwordEnc, null, "no password we don't actually know");
  assert.match(await logs(id), /already exists in Virtualizor — linked it/);
  existing = [];
});

test("an OS the master doesn't have gives a clear message instead of a dead end", async () => {
  const other = await prisma.osTemplate.create({ data: { name: `Windows Server 2012 ${RUN}`, remoteName: `win2012-${RUN}`, family: "windows", source: "virtualizor", virtualizorServerId: ids.copy, virtualizorOsId: 70002 } });
  const id = await newService(`win2012-${RUN}.example`, false);
  await prisma.service.update({ where: { id }, data: { osTemplateId: other.id } });
  await runProvisionAction(id, "create").catch(() => undefined);
  assert.match(await logs(id), /isn't among the OS templates synced from Real master/);
  await prisma.service.update({ where: { id }, data: { osTemplateId: ids.osReal } });
  await prisma.osTemplate.delete({ where: { id: other.id } });
});

test("merging the WHMCS copy moves its services, IPs, plan links and OS templates, then removes it", async () => {
  const id = await newService(`left-${RUN}.example`, false);
  const ip = await prisma.ipAddress.create({ data: { address: `198.18.${RUN.length}.${(parseInt(RUN.slice(-2), 36) % 250) + 1}`, status: "AVAILABLE", serverId: ids.copy } });
  const r = await mergeServer(ids.copy, ids.real);
  assert.ok(r.services >= 1 && r.ips === 1 && r.planLinks === 1 && r.osTemplates === 1);
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id } })).serverId, ids.real);
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id } })).osTemplateId, ids.osReal, "services use the real master's template");
  assert.equal((await prisma.ipAddress.findUniqueOrThrow({ where: { id: ip.id } })).serverId, ids.real);
  assert.ok(await prisma.productServer.findUnique({ where: { productId_serverId: { productId: ids.product, serverId: ids.real } } }));
  assert.ok(await prisma.productOs.findUnique({ where: { productId_osTemplateId: { productId: ids.product, osTemplateId: ids.osReal } } }));
  assert.equal(await prisma.osTemplate.count({ where: { id: ids.osCopy } }), 0);
  assert.equal(await prisma.server.count({ where: { id: ids.copy } }), 0);
  assert.equal((await prisma.legacyMap.findFirstOrThrow({ where: { entity: "server", legacyId: `srv-${RUN}` } })).localId, ids.real, "a re-import maps the WHMCS server to the real one");
  await prisma.ipAddress.delete({ where: { id: ip.id } });
});
