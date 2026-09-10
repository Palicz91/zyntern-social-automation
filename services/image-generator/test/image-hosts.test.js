"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseExtraHosts,
  buildAllowedHosts,
  isAllowedImageUrl,
  safeLogValue,
} = require("../lib/image-hosts");

// Regression: EXTRA_IMAGE_HOSTS entries were never lowercased while URL.hostname
// always is, so a capitalised entry silently never matched and every card shipped
// with the letter fallback instead of the company logo.
test("parseExtraHosts lowercases, so config case cannot silently break matching", () => {
  assert.deepEqual(parseExtraHosts("Zyntern.com"), ["zyntern.com"]);
  assert.deepEqual(parseExtraHosts("CDN.Zyntern.COM"), ["cdn.zyntern.com"]);
});

test("parseExtraHosts trims whitespace and drops empty entries", () => {
  assert.deepEqual(parseExtraHosts(" a.com , b.com "), ["a.com", "b.com"]);
  assert.deepEqual(parseExtraHosts("a.com,,b.com,"), ["a.com", "b.com"]);
  assert.deepEqual(parseExtraHosts("a.com\r\n"), ["a.com"]);
});

test("parseExtraHosts handles unset and empty config", () => {
  assert.deepEqual(parseExtraHosts(undefined), []);
  assert.deepEqual(parseExtraHosts(""), []);
  assert.deepEqual(parseExtraHosts(",  ,"), []);
});

test("buildAllowedHosts omits the Supabase host when it is unknown", () => {
  const withHost = buildAllowedHosts({ supabaseHost: "abc.supabase.co", extraHosts: [] });
  assert.equal(withHost.has("abc.supabase.co"), true);

  const withoutHost = buildAllowedHosts({ supabaseHost: null, extraHosts: [] });
  assert.equal(withoutHost.has("abc.supabase.co"), false);
  // The base hosts survive either way.
  assert.equal(withoutHost.has("img.logo.dev"), true);
});

test("buildAllowedHosts includes configured extra hosts", () => {
  const hosts = buildAllowedHosts({
    supabaseHost: "abc.supabase.co",
    extraHosts: parseExtraHosts("zyntern.com"),
  });
  assert.equal(hosts.has("zyntern.com"), true);
});

const HOSTS = buildAllowedHosts({
  supabaseHost: "abc.supabase.co",
  extraHosts: ["zyntern.com"],
});

test("isAllowedImageUrl accepts an allowlisted https host", () => {
  assert.equal(isAllowedImageUrl("https://abc.supabase.co/storage/x.png", HOSTS), true);
  assert.equal(isAllowedImageUrl("https://zyntern.com/logo.png", HOSTS), true);
});

test("isAllowedImageUrl rejects a host that is not on the list", () => {
  assert.equal(isAllowedImageUrl("https://evil.example/x.png", HOSTS), false);
});

test("isAllowedImageUrl rejects plaintext http even on an allowlisted host", () => {
  assert.equal(isAllowedImageUrl("http://zyntern.com/logo.png", HOSTS), false);
});

test("isAllowedImageUrl is not fooled by userinfo or subdomain lookalikes", () => {
  // userinfo before @ — hostname is still the real one, so this is allowed
  assert.equal(isAllowedImageUrl("https://evil.example@zyntern.com/x.png", HOSTS), true);
  // the reverse: allowlisted name in userinfo, attacker host is the real target
  assert.equal(isAllowedImageUrl("https://zyntern.com@evil.example/x.png", HOSTS), false);
  // suffix matching must not happen
  assert.equal(isAllowedImageUrl("https://notzyntern.com/x.png", HOSTS), false);
  assert.equal(isAllowedImageUrl("https://zyntern.com.evil.example/x.png", HOSTS), false);
});

test("isAllowedImageUrl rejects junk without throwing", () => {
  assert.equal(isAllowedImageUrl(null, HOSTS), false);
  assert.equal(isAllowedImageUrl("", HOSTS), false);
  assert.equal(isAllowedImageUrl("not a url", HOSTS), false);
  assert.equal(isAllowedImageUrl("javascript:alert(1)", HOSTS), false);
  assert.equal(isAllowedImageUrl("file:///etc/passwd", HOSTS), false);
});

// Regression: the dropped-host warning interpolated an unbounded, externally
// supplied URL straight into the journal.
test("safeLogValue strips newlines so log records cannot be forged", () => {
  assert.equal(
    safeLogValue("https://x/a\nSep 10 00:00:00 host app[1]: FAKE ENTRY"),
    "https://x/a Sep 10 00:00:00 host app[1]: FAKE ENTRY",
  );
  assert.equal(safeLogValue("a\r\nb"), "a b");
});

test("safeLogValue caps length so a large body cannot flood the log", () => {
  assert.equal(safeLogValue("x".repeat(5000)).length, 200);
});

test("safeLogValue does not throw on non-strings", () => {
  assert.equal(safeLogValue(undefined), "undefined");
  assert.equal(safeLogValue(null), "null");
});
