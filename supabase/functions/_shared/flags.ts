// Shared by oauth-start and oauth-callback so the two cannot drift apart on how a
// flag is read — they are two halves of one flow, and disagreeing about whether
// org mode is on produces a 403 after the auth code has already been consumed.

/**
 * Env flags arrive as strings from `supabase secrets set`. They routinely carry
 * stray whitespace or a trailing CR (a CRLF .env file), and operators write
 * "True" or "TRUE" as readily as "true". A strict `=== "true"` silently turns all
 * of those into "off" — which is exactly the silent behaviour these flags exist
 * to remove, so the comparison is tolerant instead.
 *
 * Only "true" enables. "1", "yes" and "on" deliberately do not: accepting them
 * would make the flag's meaning depend on which convention the operator guessed.
 */
export function isFlagEnabled(value: string | undefined | null): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}
