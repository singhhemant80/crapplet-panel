/**
 * Own mail server (Mailcow): SPF really authorises its IP, DKIM selector found, PTR / hostname / blocklists checked.
 *   npx tsx --test test/deliverability-mailcow.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDeliverability, spfAllows, type Resolver } from "../src/modules/email/deliverability";

function fake(dns: { txt?: Record<string, string[]>; a?: Record<string, string[]>; mx?: Record<string, string[]>; ptr?: Record<string, string[]> }): Resolver {
  const miss = () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
  return {
    resolveTxt: (n) => (dns.txt?.[n] ? Promise.resolve(dns.txt[n].map((t) => [t])) : miss()),
    resolveMx: (n) => (dns.mx?.[n] ? Promise.resolve(dns.mx[n].map((exchange, i) => ({ exchange, priority: 10 + i }))) : miss()),
    resolve4: (n) => (dns.a?.[n] ? Promise.resolve(dns.a[n]) : miss()),
    resolveCname: () => miss(),
    reverse: (ip) => (dns.ptr?.[ip] ? Promise.resolve(dns.ptr[ip]) : miss()),
  } as Resolver;
}
const base = {
  enabled: true, preset: "mailcow", host: "mail.example.in", port: 587, security: "starttls", user: "billing@example.in", pass: "x",
  fromEmail: "billing@example.in", fromName: "Example", replyTo: "", providerDkimSelector: "", sendingIp: "", allowSelfSigned: false,
  dkim: { enabled: false, selector: "", privateKey: "", publicKey: "" },
} as never;

test("SPF evaluation follows mx / a / include / ip4 like a receiver", async () => {
  const r = fake({ txt: { "example.in": ["v=spf1 mx include:_spf.other.test ~all"], "_spf.other.test": ["v=spf1 ip4:198.51.100.0/24 -all"] }, mx: { "example.in": ["mail.example.in"] }, a: { "mail.example.in": ["203.0.113.7"] } });
  assert.equal(await spfAllows(r, "example.in", "203.0.113.7"), "pass");
  assert.equal(await spfAllows(r, "example.in", "198.51.100.25"), "pass");
  assert.equal(await spfAllows(r, "example.in", "192.0.2.1"), "fail");
});

test("Mailcow all set up: everything green", async () => {
  const r = fake({
    txt: { "example.in": ["v=spf1 mx ~all"], "_dmarc.example.in": ["v=DMARC1; p=quarantine"], "dkim._domainkey.example.in": ["v=DKIM1;k=rsa;p=MIIB"] },
    mx: { "example.in": ["mail.example.in"] }, a: { "mail.example.in": ["203.0.113.7"] }, ptr: { "203.0.113.7": ["mail.example.in"] },
  });
  const res = await checkDeliverability(base, r);
  const by = Object.fromEntries(res.checks.map((c) => [c.key, c]));
  assert.equal(res.ip, "203.0.113.7");
  assert.equal(by.spf.status, "ok", by.spf.detail);
  assert.equal(by.dkim.status, "ok", by.dkim.detail);
  assert.equal(by.ptr.status, "ok", by.ptr.detail);
  assert.equal(by.blocklist.status, "ok");
  assert.equal(res.summary.errors, 0, JSON.stringify(res.checks.filter((c) => c.status === "error")));
});

test("Mailcow problems: SPF missing its IP, no PTR, wrong PTR name, listed IP", async () => {
  let r = fake({ txt: { "example.in": ["v=spf1 include:zoho.in ~all"], "zoho.in": ["v=spf1 ip4:136.143.0.0/16 -all"], "_dmarc.example.in": ["v=DMARC1; p=none"] }, mx: { "example.in": ["mx.zoho.in"] }, a: { "mail.example.in": ["203.0.113.7"] } });
  let res = await checkDeliverability(base, r);
  let by = Object.fromEntries(res.checks.map((c) => [c.key, c]));
  assert.equal(by.spf.status, "error");
  assert.match(by.spf.record!.value, /ip4:203\.0\.113\.7/);
  assert.equal(by.ptr.status, "error");
  assert.equal(by.dkim.status, "error", "no key under any common selector");

  r = fake({ txt: { "example.in": ["v=spf1 ip4:203.0.113.7 ~all"], "_dmarc.example.in": ["v=DMARC1; p=none"], "dkim._domainkey.example.in": ["v=DKIM1;p=AB"] }, a: { "mail.example.in": ["203.0.113.7"], "srv1.example-dc.test": ["203.0.113.7"], "7.113.0.203.zen.spamhaus.org": ["127.0.0.2"] }, ptr: { "203.0.113.7": ["srv1.example-dc.test"] } });
  res = await checkDeliverability(base, r);
  by = Object.fromEntries(res.checks.map((c) => [c.key, c]));
  assert.equal(by.spf.status, "ok");
  assert.equal(by.helo.status, "warn");
  assert.equal(by.blocklist.status, "error");
  assert.match(by.blocklist.detail, /Spamhaus/);
});
