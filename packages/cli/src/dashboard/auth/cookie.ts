/**
 * Tiny cookie parser + serializer — DASHBOARD.md §8.5.
 *
 * We avoid `@fastify/cookie` because (a) one more dep, (b) we want
 * total control over the attributes (`__Host-` prefix, SameSite=Strict,
 * etc.). The parser is RFC 6265 §5.2 compliant for the simple shape we
 * accept (no quoted values, no folded headers).
 */

export function parseCookieHeader(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw === undefined || raw === '') return out
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name === '' || out[name] !== undefined) continue
    out[name] = decodeURIComponent(value)
  }
  return out
}

export type SerializeOptions = {
  readonly httpOnly?: boolean
  readonly secure?: boolean
  readonly sameSite?: 'Strict' | 'Lax' | 'None'
  readonly path?: string
  readonly maxAgeSec?: number
}

export function serializeCookie(name: string, value: string, opts: SerializeOptions = {}): string {
  const parts: string[] = [`${name}=${encodeURIComponent(value)}`]
  if (opts.path !== undefined) parts.push(`Path=${opts.path}`)
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  if (opts.sameSite !== undefined) parts.push(`SameSite=${opts.sameSite}`)
  if (opts.maxAgeSec !== undefined) parts.push(`Max-Age=${opts.maxAgeSec}`)
  return parts.join('; ')
}

/**
 * Build the cookie name. RFC 6265bis `__Host-` prefix locks the cookie
 * to the exact origin and requires Secure + Path=/ + no Domain. We use
 * it whenever `secure` is set; bare name on loopback HTTP.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-loki_dash_sess' : 'loki_dash_sess'
}
