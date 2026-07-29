/**
 * Values the UI needs to match the server exactly.
 *
 * The browser bundle cannot import from `src/server`, so anything duplicated
 * here must be kept in step by hand — keep the list short, and keep the server
 * as the authority that actually enforces it.
 */

/** Mirrors MIN_PASSWORD_LENGTH in src/server/lib/password.ts. */
export const MIN_PASSWORD_LENGTH = 10;
