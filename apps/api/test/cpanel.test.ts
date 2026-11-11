/** cPanel/WHM helpers: username choice and WHM size strings. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toMb, usernameFromDomain } from "../src/modules/provisioning/cpanel";

test("cPanel usernames come from the domain and follow WHM's rules", () => {
  assert.equal(usernameFromDomain("acme-shop.in"), "acmeshop");
  assert.equal(usernameFromDomain("MyVeryLongBusinessName.co.in"), "myverylo");
  assert.equal(usernameFromDomain("123host.com"), "host");
  assert.equal(usernameFromDomain("testsite.com"), "utestsit"); // can't start with "test"
  assert.equal(usernameFromDomain("9.com"), "u");
  for (const d of ["a-b.c", "x1.y", "über.de"]) assert.match(usernameFromDomain(d), /^[a-z][a-z0-9]{0,7}$/);
});

test("WHM size strings convert to MB, unlimited → null", () => {
  assert.equal(toMb("5120"), 5120);
  assert.equal(toMb("12M"), 12);
  assert.equal(toMb("1.5G"), 1536);
  assert.equal(toMb("unlimited"), null);
  assert.equal(toMb("0"), null);
  assert.equal(toMb(""), null);
  assert.equal(toMb(undefined), null);
});
