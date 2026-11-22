/**
 * DKIM check finds the provider's selector on its own (mailcow publishes "dkim._domainkey").
 *   npx tsx --test test/deliverability-dkim.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDeliverability, type Resolver } from "../src/modules/email/deliverability";

const nx = () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
function dns(txt: Record<string, string>): Resolver {
  return {
    resolveTxt: (n) => (txt[n] ? Promise.resolve([[txt[n]]]) : nx()),
    resolveMx: (n) => (n === "primocloud.in" ? Promise.resolve([{ exchange: "hostpanel.hostdnscloud.in", priority: 10 }]) : nx()),
    resolve4: (n) => (n === "hostpanel.hostdnscloud.in" ? Promise.resolve(["163.52.252.58"]) : nx()),
    resolveCname: () => nx(),
    reverse: () => Promise.resolve(["hostpanel.hostdnscloud.in"]),
  };
}
const cfg = (selector = "") =>
  ({
    enabled: true, preset: "custom", host: "hostpanel.hostdnscloud.in", port: 587, security: "starttls", user: "no-reply@primocloud.in", pass: "x",
    fromEmail: "no-reply@primocloud.in", fromName: "PrimoCloud", replyTo: "", returnPath: "", ehloName: "", allowSelfSigned: false,
    providerDkimSelector: selector, dkim: { enabled: false, selector: "primocloud", privateKey: "", publicKey: "" },
  }) as never;

const records = {
  "primocloud.in": "v=spf1 ip4:163.52.252.58 -all",
  "_dmarc.primocloud.in": "v=DMARC1; p=none; rua=mailto:dmarc@primocloud.in; fo=1",
  "dkim._domainkey.primocloud.in": "v=DKIM1;k=rsa;t=s;s=email;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA",
};

test("no selector typed: mailcow's dkim._domainkey is found automatically", async () => {
  const r = await checkDeliverability(cfg(), dns(records));
  const d = (r as any).checks.find((c: any) => c.key === "dkim");
  assert.equal(d.status, "ok", d.detail);
  assert.match(d.detail, /dkim\._domainkey\.primocloud\.in/);
  assert.match(d.detail, /mailcow/);
});

test("no selector and no common key published: still asks for the selector", async () => {
  const { ["dkim._domainkey.primocloud.in"]: _d, ...rest } = records;
  const r = await checkDeliverability(cfg(), dns(rest));
  assert.equal((r as any).checks.find((c: any) => c.key === "dkim").status, "warn");
});
