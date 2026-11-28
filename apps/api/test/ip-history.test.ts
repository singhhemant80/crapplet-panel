/**
 * Service IP history: the starting point, changes made directly in Virtualizor (found by the IP
 * sync), and changes made from the panel.
 *   npx tsx --test test/ip-history.test.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { encrypt } from "../src/lib/crypto";
import { VirtualizorClient } from "../src/modules/provisioning/virtualizor";
import { syncVirtualizorIps } from "../src/modules/provisioning/virtualizor-ips";
import { serviceIpHistory, trackServiceIps } from "../src/modules/provisioning/ip-history";
import { recordServiceIps } from "../src/modules/provisioning/provisioner";

const RUN = Date.now().toString(36);
const net = `10.${(Date.now() >> 8) % 200}.${Date.now() % 200}`;
const ids: Record<string, string> = {};
after(async () => {
  await prisma.ipAddress.deleteMany({ where: { address: { startsWith: `${net}.` } } });
  await prisma.ipSubnet.deleteMany({ where: { serverId: ids.server } });
  await prisma.service.deleteMany({ where: { id: { in: [ids.a, ids.b].filter(Boolean) } } });
  await prisma.product.deleteMany({ where: { slug: `iph-${RUN}` } });
  await prisma.server.deleteMany({ where: { id: ids.server } });
  await prisma.clientProfile.deleteMany({ where: { userId: ids.user } });
  await prisma.user.deleteMany({ where: { id: ids.user } });
  await prisma.$disconnect();
});

test("starting point, direct Virtualizor changes, and panel changes are all recorded", async () => {
  const P = VirtualizorClient.prototype as any;
  let rows: Record<string, object> = {};
  P.ipPools = async () => ({ ippools: { "1": { ippool_name: "main", gateway: `${net}.1`, netmask: "255.255.255.0", ipv6: 0, nodes: "" } } });
  P.ips = async () => ({ ips: rows });
  ids.user = (await prisma.user.create({ data: { email: `iph-${RUN}@t.test`, passwordHash: "x", firstName: "I", type: "CLIENT", status: "ACTIVE", profile: { create: { currency: "INR" } } } })).id;
  ids.server = (await prisma.server.create({ data: { name: `QA iph ${RUN}`, type: "VIRTUALIZOR", hostname: "vz-iph.example.test", apiUser: "k", apiSecretEnc: encrypt("p") } as never })).id;
  const g = await prisma.productGroup.findFirstOrThrow();
  const prod = await prisma.product.create({ data: { name: "VPS", slug: `iph-${RUN}`, type: "VPS_LINUX", provisioner: "VIRTUALIZOR", groupId: g.id } as never });
  const svc = (remoteId: string) => prisma.service.create({ data: { userId: ids.user, productId: prod.id, serverId: ids.server, remoteId, status: "ACTIVE", billingCycle: "MONTHLY", recurringAmount: 1, firstAmount: 1 } as never });
  ids.a = (await svc("101")).id;
  ids.b = (await svc("102")).id;
  const server = await prisma.server.findUniqueOrThrow({ where: { id: ids.server } });
  const ip = (n: number, vpsid = "0") => ({ ip: `${net}.${n}`, vpsid, ippid: 1, locked: "0" });

  // first sync: the service's current IP is the starting point, not a change
  rows = { a: ip(10, "101"), b: ip(11), c: ip(12) };
  await syncVirtualizorIps(server);
  let h = await serviceIpHistory(ids.a);
  assert.equal(h.length, 1);
  assert.deepEqual(h[0].baseline, [`${net}.10`]);

  // changed directly in Virtualizor: .10 → .11
  rows = { a: ip(10), b: ip(11, "101"), c: ip(12) };
  const r = await syncVirtualizorIps(server);
  assert.equal(r.ipChanges, 2);
  h = await serviceIpHistory(ids.a);
  assert.equal(h[0].source, "VIRTUALIZOR");
  assert.deepEqual(h[0].added, [`${net}.11`]);
  assert.deepEqual(h[0].removed, [`${net}.10`]);

  // a later sync with nothing new writes nothing
  assert.equal((await syncVirtualizorIps(server)).ipChanges, 0);

  // changed from the panel by staff: .11 → .12, attributed
  await recordServiceIps(ids.a, ids.server, [`${net}.12`], "CHANGE_IP", { actorId: ids.user, note: "Chosen IPs" });
  h = await serviceIpHistory(ids.a);
  assert.equal(h[0].source, "CHANGE_IP");
  assert.ok(h[0].by);
  assert.deepEqual(h[0].added, [`${net}.12`]);
  assert.deepEqual(h[0].removed, [`${net}.11`]);

  // moved in Virtualizor to the other VPS: both services' histories show it
  rows = { a: ip(10), b: ip(11), c: ip(12, "102") };
  await syncVirtualizorIps(server);
  assert.deepEqual((await serviceIpHistory(ids.a))[0].removed, [`${net}.12`]);
  const hb = await serviceIpHistory(ids.b);
  assert.deepEqual(hb[0].added.length + hb[0].baseline.length, 1);
  // the history stays after the IP disappears from IP Management
  await prisma.ipAddress.deleteMany({ where: { address: `${net}.12` } });
  assert.ok((await prisma.serviceIpChange.count({ where: { address: `${net}.12` } })) >= 2);
  assert.equal(await trackServiceIps(ids.a, "VIRTUALIZOR"), 0);
});
