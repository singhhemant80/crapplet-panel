import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOsTemplates, prettyOsName } from "../src/modules/provisioning/virtualizor-os";

test("Virtualizor OS templates: both payload shapes are parsed", () => {
  const flat = parseOsTemplates({ "271": { osid: "271", type: "kvm", name: "ubuntu-22.04-x86_64", distro: "ubuntu", active: "1" }, "272": { osid: "272", type: "proxk", name: "win2019", active: "0" } });
  assert.deepEqual(flat.map((o) => [o.osid, o.virt, o.active]), [[271, "kvm", true], [272, "proxk", false]]);
  const nested = parseOsTemplates({ proxl: { debian: { "15": { name: "debian-12-x86_64.tar.gz" } } } });
  assert.deepEqual(nested.map((o) => [o.osid, o.virt, o.name]), [[15, "proxl", "debian-12-x86_64.tar.gz"]]);
});

test("Virtualizor OS templates: friendly names", () => {
  assert.equal(prettyOsName("ubuntu-24.04-x86_64"), "Ubuntu 24.04");
  assert.equal(prettyOsName("almalinux-9.4-x86_64"), "AlmaLinux 9.4");
  assert.equal(prettyOsName("win2022"), "Windows Server 2022");
  assert.equal(prettyOsName("centos-7-x86_64-cpanel"), "CentOS 7 + cPanel");
  assert.equal(prettyOsName("debian-12-x86_64.tar.gz"), "Debian 12");
});

test("one VPS is picked only by its own id — never 'the first row' of an unfiltered list", async () => {
  const { pickVps } = await import("../src/modules/provisioning/virtualizor");
  assert.equal(pickVps({ vs: { "3100": { vpsid: "3100", hostname: "a" } } }, 3100)?.hostname, "a");
  assert.equal(pickVps({ vs: { "7": { vpsid: "3100", hostname: "b" } } }, "3100")?.hostname, "b", "row whose vpsid matches");
  assert.equal(pickVps({ vs: { "1": { vpsid: "1", hostname: "other" }, "2": { vpsid: "2" } } }, "3100"), null, "unfiltered list → not found");
  assert.equal(pickVps({ vs: { "1": { vpsid: "1", hostname: "other" } } }, "3100"), null, "a single different VPS is not ours");
  assert.equal(pickVps({ vs: { x: { hostname: "c" } } }, "3100")?.hostname, "c", "lone row without an id is accepted");
  assert.equal(pickVps({ vs: {} }, "3100"), null);
  assert.equal(pickVps(null, "3100"), null);
});
