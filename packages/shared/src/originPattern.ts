/**
 * Chrome extension match pattern for the origin of an endpoint URL.
 * Match patterns cannot carry a port; a grant covers all ports on the host.
 */
export function originPattern(url: string): string {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`originPattern: only http(s) endpoints are supported, got ${u.protocol}`);
  }
  return `${u.protocol}//${u.hostname}/*`;
}
