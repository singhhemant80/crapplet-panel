/**
 * Progress of service actions (reinstall, change IP, power …) and Change IP skipping locked IPs.
 *   npx tsx --test test/service-activity.test.ts
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { closeQueues, enqueueProvision, provisioningQueue } from "../src/jobs/queues";
import { serviceActivity } from "../src/modules/provisioning/activity";
import { VirtualizorClient } from "../src/modules/provisioning/virtualizor";

const RUN = Date.now().toString(36);
const ids: Record<string, string> = {};

before(async () => {
  ids.user = (await prisma.user.create({ data: { email: `sa-${RUN}@t.test`, passwordHash: "x", firstName: "C", type: "CLIENT", status: "ACTIVE" } })).id;
  ids.group = (await prisma.productGroup.create({ data: { name: `QA SA ${RUN}`, slug: `qa-sa-${RUN}` } })).id;
  ids.product = (await prisma.product.create({ data: { groupId: ids.group, name: `SA VPS ${RUN}`, slug: `qa-sa-${RUN}`, type: "VPS_LINUX", provisioner: "PROXMOX", autoSetup: "MANUAL" } })).id;
  ids.svc = (await prisma.service.create({ data: { userId: ids.user, productId: ids.product, status: "ACTIVE", billingCycle: "MONTHLY", firstAmount: 1, recurringAmount: 1, currency: "INR" } })).id;
});
after(async () => {
  for (const j of await provisioningQueue().getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 1000, false)) if (j?.data?.serviceId === ids.svc) await j.remove().catch(() => undefined);
  await prisma.provisioningLog.deleteMany({ where: { serviceId: ids.svc } });
  await prisma.service.deleteMany({ where: { id: ids.svc } });
  await prisma.product.deleteMany({ where: { id: ids.product } });
  await prisma.productGroup.deleteMany({ where: { id: ids.group } });
  await prisma.user.deleteMany({ where: { id: ids.user } });
  await closeQueues().catch(() => undefined);
  await prisma.$disconnect();
});

test("queued action shows as queued; finished ones as done / failed; customers don't see internal errors", async () => {
  await provisioningQueue().pause(); // keep the job waiting (no worker in tests anyway)
  await enqueueProvision({ serviceId: ids.svc, action: "change_ip", params: {} });
  await prisma.provisioningLog.create({ data: { serviceId: ids.svc, action: "reboot_started", success: true, message: "Started" } });
  await prisma.provisioningLog.create({ data: { serviceId: ids.svc, action: "reboot", success: true, message: "Rebooted on node pve1" } });
  await prisma.provisioningLog.create({ data: { serviceId: ids.svc, action: "reset_password", success: false, message: "Proxmox said 500: qemu-guest-agent not running" } });
  await prisma.provisioningLog.create({ data: { serviceId: ids.svc, action: "suspend", success: true, message: "Suspended" } });

  const a = await serviceActivity(ids.svc, "admin");
  assert.equal(a.active, true);
  const ip = a.items.find((i) => i.action === "change_ip")!;
  assert.equal(ip.state, "queued");
  assert.equal(a.items.find((i) => i.action === "reboot")!.state, "done");
  const pw = a.items.find((i) => i.action === "reset_password")!;
  assert.equal(pw.state, "failed");
  assert.match(pw.message, /guest-agent/);
  assert.ok(a.items.some((i) => i.action === "suspend"), "staff see suspend");

  const c = await serviceActivity(ids.svc, "client");
  assert.ok(!JSON.stringify(c).includes("guest-agent"), "no internal error for customers");
  assert.ok(!c.items.some((i) => i.action === "suspend"), "customers don't get suspend cards");
  assert.equal(c.items.find((i) => i.action === "change_ip")!.state, "queued");
  await provisioningQueue().resume();
});

test("change IP: never picks locked IPs or IPs of a locked pool", async () => {
  const c = new VirtualizorClient({ host: "v.example.test", port: 4085, apiKey: "k", apiPass: "p", verifyTls: false });
  let posted: any = null;
  (c as any).call = async (act: string, q: any, post?: any) => {
    if (act === "editvs" && post) { posted = post; return {}; }
    if (act === "editvs") return { vps: { vpsid: "5", hostname: "h", ips: { 1: "10.0.0.1" } }, ips: [{ ip: "10.0.0.2" }, { ip: "10.0.1.5" }, { ip: "10.0.0.3" }, { ip: "10.0.0.4" }] };
    if (act === "ippool") return { ippools: { 7: { ippid: "7", locked: "1" }, 8: { ippid: "8" } } };
    if (act === "ips") return { ips: { a: { ip: "10.0.0.2", ippid: "8", locked: "1" }, b: { ip: "10.0.1.5", ippid: "7" }, c: { ip: "10.0.0.3", ippid: "8", locked: "0" } } };
    throw new Error(`unexpected ${act} ${JSON.stringify(q)}`);
  };
  const got = await c.replaceIps("5");
  assert.deepEqual(got, ["10.0.0.3"]);
  assert.deepEqual(posted.ips, ["10.0.0.3"]);

  (c as any).call = async (act: string, _q: any, post?: any) => {
    if (act === "editvs" && !post) return { vps: { vpsid: "5", hostname: "h", ips: { 1: "10.0.0.1" } }, ips: [{ ip: "10.0.1.5" }] };
    if (act === "ippool") return { ippools: { 7: { ippid: "7", locked: 1 } } };
    if (act === "ips") return { ips: { b: { ip: "10.0.1.5", ippid: "7" } } };
    throw new Error("should not post");
  };
  await assert.rejects(c.replaceIps("5"), /locked in Virtualizor/);
});
