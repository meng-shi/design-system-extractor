/**
 * URL validation shared by the rendered and static extractors.
 *
 * A public deployment fetches URLs supplied by visitors, so these guards are
 * the first line of defense against SSRF (including DNS rebinding and
 * redirect-based bypasses).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DNS_CACHE_TTL_MS = 60_000;
const dnsCache = new Map<string, { expires: number; addresses: string[] }>();

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '');
}

/** True for loopback, private, link-local, CGNAT, multicast, and reserved IPs. */
export function isPrivateAddress(address: string): boolean {
  const ip = stripBrackets(address).trim();
  const version = isIP(ip);

  if (version === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
    if (lower.startsWith('ff')) return true;
    const mapped = lower.match(/^::ffff:(.+)$/);
    if (mapped) {
      if (mapped[1].includes('.')) return isPrivateAddress(mapped[1]);
      const segments = mapped[1].split(':');
      if (segments.length === 2) {
        const hi = Number.parseInt(segments[0], 16);
        const lo = Number.parseInt(segments[1], 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
        }
      }
    }
    return false;
  }

  return true;
}

/** Synchronous checks: scheme, credentials, literal hosts, and blocked names. */
export function assertSafeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Enter a valid website URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs can be extracted.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed.');
  }

  const hostname = stripBrackets(parsed.hostname.toLowerCase()).replace(/\.$/, '');
  if (!hostname) {
    throw new Error('Enter a valid website URL.');
  }

  const blockedHostname =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal';

  const numericHost = /^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname);
  const privateLiteral = isIP(hostname) !== 0 && isPrivateAddress(hostname);

  if (blockedHostname || numericHost || privateLiteral) {
    throw new Error('Local and private network URLs cannot be extracted.');
  }
}

/**
 * Resolves the hostname and rejects URLs that point at internal addresses.
 * Caches lookups briefly to avoid paying DNS latency for every stylesheet.
 */
export async function assertSafeUrlResolved(url: string): Promise<void> {
  assertSafeUrl(url);
  const hostname = stripBrackets(new URL(url).hostname.toLowerCase());
  if (isIP(hostname)) return;

  const now = Date.now();
  const cached = dnsCache.get(hostname);
  let addresses: string[];

  if (cached && cached.expires > now) {
    addresses = cached.addresses;
  } else {
    try {
      const records = await lookup(hostname, { all: true, verbatim: true });
      addresses = records.map((record) => record.address);
    } catch {
      throw new Error('The hostname could not be resolved.');
    }
    if (dnsCache.size > 500) dnsCache.clear();
    dnsCache.set(hostname, { expires: now + DNS_CACHE_TTL_MS, addresses });
  }

  if (addresses.length === 0) {
    throw new Error('The hostname could not be resolved.');
  }
  if (addresses.some((address) => isPrivateAddress(address))) {
    throw new Error('Local and private network URLs cannot be extracted.');
  }
}
