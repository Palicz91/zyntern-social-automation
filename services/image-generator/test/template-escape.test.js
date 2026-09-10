"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The escape lives in the browser-side render() inside template.html, so the test
// reads it back out of the shipped file. That way the test fails if the escape is
// weakened in the artifact that actually runs, not in a copy of it.
const TEMPLATE = path.join(__dirname, "..", "template.html");

function loadEscape() {
  const html = fs.readFileSync(TEMPLATE, "utf8");
  const block = html.match(/const CSS_URL_ESCAPES = \{[\s\S]*?\);/);
  assert.ok(block, "could not find the cover_image_url escape in template.html");
  const fn = new Function("data", block[0] + " return safeCover;");
  return (value) => fn({ cover_image_url: value });
}

// Regression: cover_image_url was interpolated raw into `url(...)`. Because the
// host allowlist runs before this point and only checks the hostname, an
// allowlisted URL carrying `),url(` smuggled a second, non-allowlisted fetch into
// the --no-sandbox Chromium — bypassing the allowlist completely.
test("a second url() cannot be smuggled through cover_image_url", () => {
  const escape = loadEscape();
  const payload =
    "https://img.logo.dev/a.png),url(http://127.0.0.1:9000/probe";
  const escaped = escape(payload);

  assert.ok(!escaped.includes("("), "an unescaped ( survived");
  assert.ok(!escaped.includes(")"), "an unescaped ) survived");
  assert.ok(
    !`url("${escaped}")`.includes("),url("),
    "the injected second url() survived escaping",
  );
});

test("quotes cannot break out of the url(\"...\") wrapper", () => {
  const escape = loadEscape();
  for (const payload of [
    'https://img.logo.dev/a.png"),url("http://127.0.0.1:9000/x',
    "https://img.logo.dev/a.png'),url('http://127.0.0.1:9000/x",
  ]) {
    const escaped = escape(payload);
    assert.ok(!/["']/.test(escaped), `an unescaped quote survived: ${escaped}`);
  }
});

test("whitespace and backslashes are escaped too", () => {
  const escape = loadEscape();
  assert.ok(!/\s/.test(escape("https://img.logo.dev/a b.png")));
  assert.ok(!escape("https://img.logo.dev/a\\b.png").includes("\\"));
});

// encodeURIComponent alone does NOT escape ( ) ' * !, which is why the first
// attempt at this fix silently did nothing. Guard against regressing to it.
test("the escape is stronger than encodeURIComponent alone", () => {
  const escape = loadEscape();
  const parens = "https://img.logo.dev/a().png";
  assert.notEqual(
    escape(parens),
    encodeURIComponent(parens),
    "the escape appears to be plain encodeURIComponent, which leaves ( ) unescaped",
  );
  assert.ok(!/[()]/.test(escape(parens)));
});

test("an ordinary logo URL passes through unchanged", () => {
  const escape = loadEscape();
  const normal = "https://zyntern.com/favicons/apple-icon-152x152.png";
  assert.equal(escape(normal), normal);
});
