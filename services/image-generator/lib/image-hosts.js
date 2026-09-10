"use strict";

// Extracted from server.js so the allowlist rules can be tested. Every function
// here is pure; server.js owns the process-level config and exit behaviour.

// Hosts that are allowed regardless of configuration.
const BASE_IMAGE_HOSTS = [
  "lh3.googleusercontent.com",
  "logo.clearbit.com",
  "img.logo.dev",
];

// URL.hostname is always lowercased by the parser, so entries must be lowercased
// too or they can never match and fail silently.
function parseExtraHosts(raw) {
  return String(raw || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function buildAllowedHosts({ supabaseHost, extraHosts }) {
  return new Set([
    ...(supabaseHost ? [supabaseHost] : []),
    ...BASE_IMAGE_HOSTS,
    ...(extraHosts || []),
  ]);
}

function isAllowedImageUrl(url, allowedHosts) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && allowedHosts.has(parsed.hostname);
  } catch {
    return false;
  }
}

// logo_url and cover_image_url come from an external portal. Strip newlines so a
// value cannot forge journal records, and cap length so a large body cannot
// flood the disk through the log.
function safeLogValue(value) {
  return String(value).replace(/[\r\n]+/g, " ").slice(0, 200);
}

module.exports = {
  BASE_IMAGE_HOSTS,
  parseExtraHosts,
  buildAllowedHosts,
  isAllowedImageUrl,
  safeLogValue,
};
