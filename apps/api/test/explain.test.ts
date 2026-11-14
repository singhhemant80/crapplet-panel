/**
 * Setup failures explained in plain words for every kind of product (Virtualizor, Proxmox, cPanel,
 * domains, our own checks) — and shown on the service, in the list and in the tracker.
 *   npx tsx --test test/explain.test.ts
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { explainProvisionError as x } from "../src/modules/provisioning/explain";

const V = { provisioner: "VIRTUALIZOR", serverName: "Noida Master", productId: "p1", productName: "Linux VPS G1" };
const P = { provisioner: "PROXMOX", serverName: "PVE Noida" };
const C = { provisioner: "CPANEL", serverName: "cPanel 1", productId: "p2", productName: "Starter Hosting" };

test("network problems → can't connect, with the server and a link to fix it", () => {
  const r = x("Could not reach 10.0.0.5:4085 (connection timed out). Check that port 4085 is open…", V);
  assert.equal(r.category, "connection");
  assert.equal(r.title, "Couldn't connect to “Noida Master”");
  assert.equal(r.link?.href, "/admin/servers");
  assert.equal(x("10.0.0.5:8006 refused the connection — nothing is listening on port 8006.", P).category, "connection");
});

test("credentials refused, for each panel", () => {
  assert.equal(x("Virtualizor rejected the API login (HTTP 302 redirect to /index.php). Check: (1)…", V).category, "login");
  assert.equal(x("WHM refused the API token (HTTP 403). Check the username and API token", C).category, "login");
  const p = x("Proxmox GET /nodes failed (401): authentication failure", P);
  assert.equal(p.category, "login");
  assert.match(p.title, /PVE Noida/);
});

test("plan not set up → points at the plan", () => {
  const r = x(`Plan "Starter Hosting" has no WHM package — choose one under Products → Starter Hosting → Provisioning`, C);
  assert.equal(r.category, "setup");
  assert.equal(r.link?.href, "/admin/products/p2");
  assert.equal(x("No enabled Virtualizor server exists — add one under Infrastructure → Servers", V).category, "setup");
  assert.equal(x("OS template \"Ubuntu 22\" has no Proxmox KVM template VMID", P).link?.href, "/admin/os-templates");
});

test("OS, IPs, capacity, duplicates, timeouts", () => {
  assert.equal(x(`"Windows Server 2022" isn't available on srv (WHMCS) — sync OS templates for that master`, V).category, "os");
  assert.equal(x("Virtualizor has no free IPs for this VPS's node", V).category, "ip");
  assert.equal(x(`No Proxmox node in "PVE Noida" has capacity (thresholds: CPU 85%, RAM 90%, disk 90%)`, P).category, "capacity");
  assert.equal(x(`Every cPanel server for "Starter Hosting" is full (Max services reached) — raise the limit or add a server`, C).category, "capacity");
  assert.equal(x("example.com is already hosted on cPanel 1 (service abc) — use another domain", C).category, "exists");
  assert.equal(x("Virtualizor didn't answer the create request in time. Check Virtualizor → Virtual Servers…", V).category, "timeout");
  assert.equal(x("Setup stopped more than a day ago without finishing — click Retry provisioning if it's still wanted", V).category, "stopped");
});

test("the remote panel's own reasons are pulled out of its raw reply", () => {
  const r = x('Virtualizor addvs: {"hostname":"Invalid hostname","rootpass":"The password must be at least 8 characters"}', V);
  assert.equal(r.category, "input");
  assert.equal(r.cause, "Invalid hostname; The password must be at least 8 characters");
  assert.match(r.title, /refused the details/);
  const w = x("WHM createacct: Sorry, a group for that username already exists.", C);
  assert.equal(w.category, "exists");
  assert.equal(w.cause, "Sorry, a group for that username already exists.");
  const p = x("Proxmox POST /nodes/pve1/qemu/101/clone failed (500): can't lock file '/var/lock/qemu-server/lock-9000.conf' - got timeout", P);
  assert.equal(p.cause, "can't lock file '/var/lock/qemu-server/lock-9000.conf' - got timeout");
});

test("anything else still says something useful, and customers never see internals", () => {
  const r = x("boom", V);
  assert.equal(r.category, "unknown");
  assert.equal(r.cause, "boom");
  assert.match(r.fix, /Retry/);
  assert.doesNotMatch(r.customer, /Virtualizor|boom|server/i);
  assert.equal(x(null).cause, "Unknown error");
  assert.equal(x("registrar said: domain not available", { kind: "domain" }).title, "Setup failed");
});

after(async () => {
  await prisma.$disconnect();
});
