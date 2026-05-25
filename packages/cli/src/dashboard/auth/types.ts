/**
 * Shared auth types — `AuthScheme`, `Session`, request decorations.
 *
 * Kept in their own module so `auth/*` and `routes/*` can both import
 * without cycles.
 */

export type AuthScheme =
  | { readonly kind: 'none' }
  | { readonly kind: 'bearer'; readonly token: string }
  | { readonly kind: 'basic'; readonly user: string; readonly argon2Hash: string }

export type SessionPayload = {
  /** Subject identifier — operator handle for basic; sha256-prefix of bearer; 'anonymous' for none. */
  readonly subject: string
  /** Auth scheme this session was minted under. */
  readonly scheme: 'bearer' | 'basic' | 'none'
  /** Session id — rotates on auth / scheme change / POST. 16 random bytes, base64url. */
  readonly sid: string
  /** CSRF token — 32 random bytes, base64url. Returned to the UI via /api/v1/csrf. */
  readonly csrf: string
  /** Created at, ms since epoch. */
  readonly issuedAt: number
  /** Expires at, ms since epoch (sliding within absolute timeout). */
  readonly expiresAt: number
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved session for the current request. `null` when no auth and not 'none' scheme. */
    session?: SessionPayload | null
  }
}
