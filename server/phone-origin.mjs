// Pairing invitations and browser writes must agree on the single public origin.
export function phoneOrigin(value = process.env.ASTERHELM_PUBLIC_ORIGIN || process.env.SUPER_AGENT_PHONE_ORIGIN) {
  let url;
  try { url = new URL(value); } catch { throw Error('Set ASTERHELM_PUBLIC_ORIGIN to the public HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.href !== url.origin + '/') {
    throw Error('ASTERHELM_PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query or fragment');
  }
  return url.origin;
}
