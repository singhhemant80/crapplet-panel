/**
 * "Sync all from Virtualizor": IPs and operating system reach the customer's service, and services
 * that were never linked to a VPS (imported without a VPS id) are linked by IP or hostname.
 *   npx tsx --test test/virtualizor-sync.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { encrypt } from "../src/lib/crypto";
import { VirtualizorClient } from "../src/modules/provisioning/virtualizor";
import { runSyncAll, type SyncAllState } from "../src/modules/provisioning/virtualizor-sync-all";
import { closeQueues } from "../src/jobs/queues";

const RUN = Date.now().toString(36);
const n = (parseInt(RUN.slice(-3), 36) % 200) + 20;
const ip = (k: number) => `198.19.${n}.${k}`;
let serverId = "";
let productId = "";
let userId = "";
const svc: Record<string, string> = {};

// the master's VPS list
const V = 900000 + (parseInt(RUN.slice(-4), 36) % 90000);
const VPS: Record<string, Record<string, unknown>> = {
  [`${V + 1}`]: { vpsid: `${V+1}`, hostname: `linked-${RUN}`, serid: "2", ips: { "1": ip(1) }, osid: "271", os_name: "ubuntu-22.04-x86_64", os_distro: "ubuntu" },
  [`${V + 2}`]: { vpsid: `${V+2}`, hostname: `byip-${RUN}`, serid: "1", ips: { "2": ip(2), "3": ip(3) }, osid: "9001", os_name: "almalinux-9-x86_64", os_distro: "almalinux" },
  [`${V + 3}`]: { vpsid: `${V+3}`, hostname: `byhost-${RUN}`, serid: "1", ips: { "4": ip(4) }, osid: "271", os_name: "ubuntu-22.04-x86_64" },
  [`${V + 5}`]: { vpsid: `${V + 5}`, hostname: `noips-${RUN}`, serid: "1", osid: "271", os_name: "ubuntu-22.04-x86_64" },
  [`${V + 6}`]: { vpsid: `${V + 6}`, hostname: `single-${RUN}`, serid: "1" },
  [`${V + 4}`]: { vpsid: `${V+4}`, hostname: `twin-${RUN}`, serid: "1", ips: { "5": ip(5) } },
};

before(async () => {
  serverId = (await prisma.server.create({ data: { name: `virt-${RUN}`, type: "VIRTUALIZOR", hostname: "virt.invalid", apiUser: "k", apiSecretEnc: encrypt("p") } })).id;
  await prisma.osTemplate.create({ data: { name: "Ubuntu 22.04", remoteName: "ubuntu-22.04-x86_64", source: "virtualizor", virtualizorServerId: serverId, virtualizorOsId: 271, family: "linux" } });
  const g = await prisma.productGroup.create({ data: { name: `QA virt ${RUN}`, slug: `qa-virt-${RUN}` } });
  productId = (await prisma.product.create({ data: { groupId: g.id, name: `QA VPS ${RUN}`, slug: `qa-vps-${RUN}`, type: "VPS_LINUX", provisioner: "VIRTUALIZOR", autoSetup: "MANUAL" } })).id;
  userId = (await prisma.user.create({ data: { email: `virt-${RUN}@t.test`, passwordHash: "x", firstName: "V", lastName: "S", type: "CLIENT", status: "ACTIVE" } })).id;
  const mk = async (k: string, data: Record<string, unknown>, ips: string[] = []) => {
    const s = await prisma.service.create({ data: { userId, productId, status: "ACTIVE", billingCycle: "MONTHLY", firstAmount: 39900, recurringAmount: 39900, currency: "INR", ...data } });
    for (const [i, a] of ips.entries()) await prisma.ipAddress.create({ data: { address: a, status: "ALLOCATED", serviceId: s.id, isPrimary: i === 0 } });
    svc[k] = s.id;
  };
  await mk("linked", { serverId, remoteId: `${V+1}`, hostname: `linked-${RUN}` }); // linked, no IP / OS yet (the screenshot case)
  await mk("byip", { hostname: `old-name-${RUN}` }, [ip(2)]); // imported: no VPS id, no server, one of its IPs
  await mk("byhost", { hostname: `byhost-${RUN}` }); // imported: only the hostname
  await mk("twinA", { hostname: `twin-${RUN}` }); // two services claim the same hostname → not guessed
  await mk("twinB", { hostname: `twin-${RUN}` });
  await mk("nothing", { hostname: `nowhere-${RUN}` });
  await mk("single", { serverId, remoteId: `${V + 6}`, hostname: `single-${RUN}` });
  await mk("noips", { serverId, remoteId: `${V + 5}`, hostname: `noips-${RUN}` });

  // our test master answers with VPS; any other master in the dev database is "unreachable"
  VirtualizorClient.prototype.listVps = async function (this: { creds: { host: string } }, page: number) {
    if (this.creds.host !== "virt.invalid") throw new Error("unreachable in tests");
    return { vs: page === 1 ? JSON.parse(JSON.stringify(VPS)) : {} } as never;
  } as never;
  // asked about one VPS, Virtualizor includes its IPs (the list above doesn't, for V+6)
  VirtualizorClient.prototype.call = async function (this: { creds: { host: string } }, act: string, params: Record<string, unknown> = {}) {
    if (this.creds.host !== "virt.invalid") throw new Error("unreachable in tests");
    if (act === "vs" && params.vpsid === `${V + 6}`) return { vs: { [`${V + 6}`]: { vpsid: `${V + 6}`, ips: { "77": ip(11) } } } };
    if (act === "vs" && params.vpsid) return { vs: {} };
    throw new Error(`unexpected ${act}`);
  } as never;
  VirtualizorClient.prototype.ips = async function (this: { creds: { host: string } }) {
    if (this.creds.host !== "virt.invalid") throw new Error("unreachable in tests");
    return { ips: { "901": { ip: ip(9), vpsid: `${V + 5}` }, "902": { ip: ip(10), vpsid: "0" } } } as never;
  } as never;
});

after(async () => {
  await prisma.provisioningLog.deleteMany({ where: { serviceId: { in: Object.values(svc) } } });
  await prisma.ipAddress.deleteMany({ where: { address: { startsWith: `198.19.${n}.` } } });
  await prisma.service.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.productGroup.deleteMany({ where: { slug: `qa-virt-${RUN}` } });
  await prisma.osTemplate.deleteMany({ where: { virtualizorServerId: serverId } });
  await prisma.server.deleteMany({ where: { id: serverId } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

const fresh = (): SyncAllState => ({ status: "running", startedAt: new Date().toISOString(), phase: "", servers: [], checked: 0, total: 0, updated: 0, unchanged: 0, missing: [], duplicates: [], changes: [] });
const look = (id: string) => prisma.service.findUniqueOrThrow({ where: { id }, include: { ips: { orderBy: { address: "asc" } }, osTemplate: true } });

test("sync gives customers' services their IPs and operating system, and links imported ones", async () => {
  const s = await runSyncAll(fresh());
  assert.equal(s.status, "done");

  const linked = await look(svc.linked);
  assert.deepEqual(linked.ips.map((i) => i.address), [ip(1)]);
  assert.equal(linked.osTemplate?.name, "Ubuntu 22.04", "the master's template is used");
  assert.equal(linked.node, "2");

  const byIp = await look(svc.byip);
  assert.equal(byIp.remoteId, `${V+2}`);
  assert.equal(byIp.serverId, serverId);
  assert.deepEqual(byIp.ips.map((i) => i.address), [ip(2), ip(3)], "all the VPS's IPs");
  assert.equal(byIp.osTemplate?.name, "AlmaLinux 9", "an OS the master no longer lists is still shown");
  assert.equal(byIp.osTemplate?.enabled, false, "…but not offered for new orders");
  assert.equal(byIp.hostname, `byip-${RUN}`);

  const byHost = await look(svc.byhost);
  assert.equal(byHost.remoteId, `${V+3}`);
  assert.deepEqual(byHost.ips.map((i) => i.address), [ip(4)]);

  for (const k of ["twinA", "twinB", "nothing"]) assert.equal((await look(svc[k])).remoteId, null, `${k} isn't guessed`);
  assert.equal(s.linked, 2);
  assert.deepEqual(s.notLinked?.map((x) => x.serviceId).filter((id) => Object.values(svc).includes(id)).sort(), [svc.twinA, svc.twinB, svc.nothing].sort());
  assert.ok(s.changes.some((c) => c.serviceId === svc.byip && c.linked === `VPS ${V + 2}` && c.os === "AlmaLinux 9"));

  assert.deepEqual((await look(svc.noips)).ips.map((i) => i.address), [ip(9)], "IPs from Virtualizor's IP list when the VPS row has none");

  assert.deepEqual((await look(svc.single)).ips.map((i) => i.address), [ip(11)], "IPs from the single-VPS answer when the list and IP list have none");

  // what the client area reads
  const clientView = await prisma.service.findMany({ where: { userId, id: { in: [svc.linked, svc.byip, svc.byhost] } }, include: { ips: true, osTemplate: true } });
  assert.ok(clientView.every((x) => x.ips.length && x.osTemplate?.name));
});

test("a second run changes nothing", async () => {
  const s = await runSyncAll(fresh());
  assert.equal(s.updated, 0);
  assert.equal(s.linked, 0);
  assert.equal(s.unchanged, 5);
});
