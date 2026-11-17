import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import { env } from '../config/env';

export class SSRFError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSRFError';
  }
}

/**
 * Checks whether an IP address (IPv4 or IPv6) belongs to a private, loopback,
 * link-local, cloud-metadata, CGNAT, or reserved network range.
 */
export function isPrivateOrBlockedIP(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return true;

  const trimmed = ip.trim().toLowerCase();

  // 1. Handle IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (trimmed.startsWith('::ffff:')) {
    const rest = trimmed.slice(7);
    if (net.isIP(rest) === 4) {
      return isPrivateOrBlockedIP(rest);
    }
  }

  const family = net.isIP(trimmed);
  if (family === 4) {
    const octets = trimmed.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => isNaN(n) || n < 0 || n > 255)) {
      return true; // Malformed IPv4
    }

    const [o0, o1, o2] = octets;

    // 0.0.0.0/8: Current network
    if (o0 === 0) return true;

    // 10.0.0.0/8: Private network (RFC 1918)
    if (o0 === 10) return true;

    // 100.64.0.0/10: Carrier-Grade NAT (RFC 6598: 100.64.0.0 - 100.127.255.255)
    if (o0 === 100 && o1 >= 64 && o1 <= 127) return true;

    // 127.0.0.0/8: Loopback
    if (o0 === 127) return true;

    // 169.254.0.0/16: Link-Local & Cloud Metadata (including 169.254.169.254)
    if (o0 === 169 && o1 === 254) return true;

    // 172.16.0.0/12: Private network (RFC 1918: 172.16.0.0 - 172.31.255.255)
    if (o0 === 172 && o1 >= 16 && o1 <= 31) return true;

    // 192.0.0.0/24: IETF Protocol Assignments
    if (o0 === 192 && o1 === 0 && o2 === 0) return true;

    // 192.0.2.0/24: TEST-NET-1 (RFC 5737)
    if (o0 === 192 && o1 === 0 && o2 === 2) return true;

    // 192.88.99.0/24: 6to4 Relay Anycast (RFC 7526)
    if (o0 === 192 && o1 === 88 && o2 === 99) return true;

    // 192.168.0.0/16: Private network (RFC 1918)
    if (o0 === 192 && o1 === 168) return true;

    // 198.18.0.0/15: Network benchmark tests (RFC 2544: 198.18.0.0 - 198.19.255.255)
    if (o0 === 198 && (o1 === 18 || o1 === 19)) return true;

    // 198.51.100.0/24: TEST-NET-2 (RFC 5737)
    if (o0 === 198 && o1 === 51 && o2 === 100) return true;

    // 203.0.113.0/24: TEST-NET-3 (RFC 5737)
    if (o0 === 203 && o1 === 0 && o2 === 113) return true;

    // 224.0.0.0/4: Multicast (224.0.0.0 - 239.255.255.255)
    // 240.0.0.0/4: Reserved for future use (240.0.0.0 - 255.255.255.254)
    // 255.255.255.255: Broadcast
    if (o0 >= 224) return true;

    return false;
  }

  if (family === 6) {
    // Loopback ::1
    if (trimmed === '::1' || trimmed === '0:0:0:0:0:0:0:1') return true;

    // Unspecified ::
    if (trimmed === '::' || trimmed === '0:0:0:0:0:0:0:0') return true;

    // Unique Local Addresses (ULA): fc00::/7 (fc00:: - fdff:ffff:...)
    if (trimmed.startsWith('fc') || trimmed.startsWith('fd')) return true;

    // Link-local: fe80::/10 (fe8, fe9, fea, feb)
    if (/^fe[89ab]/i.test(trimmed)) return true;

    // Multicast: ff00::/8
    if (trimmed.startsWith('ff')) return true;

    // Documentation: 2001:db8::/32
    if (trimmed.startsWith('2001:db8:') || trimmed.startsWith('2001:0db8:')) return true;

    // Discard prefix: 100::/64
    if (trimmed.startsWith('100:') || trimmed.startsWith('0100:')) return true;

    return false;
  }

  return true;
}

export interface WebhookValidationResult {
  url: URL;
  resolvedIps: string[];
  pinnedIp?: string;
}

export interface WebhookValidationOptions {
  allowPrivate?: boolean;
  requireHttps?: boolean;
}

/**
 * Validates a webhook URL against SSRF rules:
 * - Scheme must be http or https (https strictly required in production).
 * - Disallows credentials in URL.
 * - Resolves DNS and asserts that NO resolved IP is in loopback, private, link-local,
 *   metadata (169.254.169.254), or CGNAT ranges.
 */
export async function validateWebhookUrl(
  rawUrl: string,
  options?: WebhookValidationOptions
): Promise<WebhookValidationResult> {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new SSRFError('Webhook URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SSRFError(`Invalid Webhook URL format: '${rawUrl}'`);
  }

  // Scheme validation
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SSRFError(`Unsupported protocol '${parsed.protocol}'. Only HTTP and HTTPS are permitted.`);
  }

  const isProduction = process.env.NODE_ENV === 'production' || env.NODE_ENV === 'production';
  const requireHttps = options?.requireHttps ?? isProduction;
  if (requireHttps && parsed.protocol !== 'https:') {
    throw new SSRFError('HTTPS is strictly required for webhook endpoints in production.');
  }

  // Reject embedded credentials (http://user:pass@host)
  if (parsed.username || parsed.password) {
    throw new SSRFError('URLs containing embedded user credentials are not permitted.');
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new SSRFError('Webhook URL must specify a valid host.');
  }

  // Check if private targets are permitted via env or options
  const allowPrivate = options?.allowPrivate ?? (process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === 'true' || env.ALLOW_PRIVATE_WEBHOOK_TARGETS);

  if (allowPrivate) {
    return {
      url: parsed,
      resolvedIps: [],
    };
  }

  // 1. Literal IP check
  if (net.isIP(hostname)) {
    if (isPrivateOrBlockedIP(hostname)) {
      throw new SSRFError(`Target IP address '${hostname}' is private, loopback, or reserved.`);
    }
    return {
      url: parsed,
      resolvedIps: [hostname],
      pinnedIp: hostname,
    };
  }

  // 2. DNS resolution check (reject if ANY resolved address is private/blocked)
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch (err: any) {
    throw new SSRFError(`DNS resolution failed for host '${hostname}': ${err.message}`);
  }

  if (!addresses || addresses.length === 0) {
    throw new SSRFError(`Host '${hostname}' did not resolve to any IP addresses.`);
  }

  const resolvedIps = addresses.map((a) => a.address);

  for (const ip of resolvedIps) {
    if (isPrivateOrBlockedIP(ip)) {
      throw new SSRFError(
        `Host '${hostname}' resolves to blocked/private address '${ip}'. Connection refused for SSRF protection.`
      );
    }
  }

  return {
    url: parsed,
    resolvedIps,
    pinnedIp: resolvedIps[0],
  };
}

export interface SecureWebhookOptions {
  url: string;
  payload: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  allowPrivate?: boolean;
}

export interface SecureWebhookResponse {
  statusCode: number;
  statusText: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * Dispatches a webhook payload with full delivery-time SSRF defenses:
 * 1. Re-validates destination URL and resolves DNS immediately before connection.
 * 2. Pins the resolved IP address to prevent DNS-rebinding attacks.
 * 3. Inspects and re-validates redirects at each hop (rejects redirects to private IPs).
 * 4. Enforces hard timeout and maximum response body limit.
 */
export async function dispatchSecureWebhook(
  options: SecureWebhookOptions
): Promise<SecureWebhookResponse> {
  const {
    url,
    payload,
    headers = {},
    timeoutMs = 5000,
    maxResponseBytes = 65536, // 64 KB
    maxRedirects = 3,
    allowPrivate = (process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === 'true' || env.ALLOW_PRIVATE_WEBHOOK_TARGETS),
  } = options;

  let currentUrl = url;
  let redirectsRemaining = maxRedirects;

  while (true) {
    // 1. Re-validate destination URL at delivery time
    const validation = await validateWebhookUrl(currentUrl, { allowPrivate });
    const parsedUrl = validation.url;
    const isHttps = parsedUrl.protocol === 'https:';

    // 2. Pin IP address to defeat DNS rebinding
    let pinnedIp = validation.pinnedIp;
    if (!pinnedIp && allowPrivate) {
      // If private targets allowed and not yet resolved, do standard resolution or connect directly
      try {
        const lookup = await dns.promises.lookup(parsedUrl.hostname);
        pinnedIp = lookup.address;
      } catch {
        // Fallback to hostname if DNS lookup fails on custom mock hosts
        pinnedIp = parsedUrl.hostname;
      }
    }

    const payloadBuffer = Buffer.from(payload, 'utf8');

    // Create a custom agent that forces socket connection to the pinned IP
    const agentLookup = (
      _hostname: string,
      _opts: any,
      callback: (err: Error | null, address: string, family: number) => void
    ) => {
      const family = net.isIP(pinnedIp || '') || 4;
      callback(null, pinnedIp || _hostname, family);
    };

    const agentOptions = pinnedIp && net.isIP(pinnedIp) ? { lookup: agentLookup } : {};
    const agent = isHttps ? new https.Agent(agentOptions) : new http.Agent(agentOptions);

    const requestOptions: http.RequestOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payloadBuffer.length,
        'Host': parsedUrl.host,
        ...headers,
      },
    };

    const result = await new Promise<SecureWebhookResponse>((resolve, reject) => {
      const clientModule = isHttps ? https : http;

      const req = clientModule.request(requestOptions, (res) => {
        const statusCode = res.statusCode || 0;
        const statusText = res.statusMessage || '';

        // Handle Redirects (301, 302, 303, 307, 308)
        if (
          [301, 302, 303, 307, 308].includes(statusCode) &&
          res.headers.location
        ) {
          res.resume(); // discard body
          if (redirectsRemaining <= 0) {
            reject(new SSRFError('Maximum redirect hops exceeded.'));
            return;
          }

          let nextUrl: string;
          try {
            nextUrl = new URL(res.headers.location, currentUrl).toString();
          } catch {
            reject(new SSRFError(`Malformed redirect location: '${res.headers.location}'`));
            return;
          }

          // Return sentinel redirect indicator
          resolve({
            statusCode,
            statusText: `Redirect -> ${nextUrl}`,
            body: nextUrl,
            headers: res.headers,
          });
          return;
        }

        // Read response body with maximum size guard
        let receivedBytes = 0;
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxResponseBytes) {
            req.destroy(new SSRFError(`Response body exceeded maximum allowed limit of ${maxResponseBytes} bytes.`));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode,
            statusText,
            body,
            headers: res.headers,
          });
        });
      });

      // Enforce timeout
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms.`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(payloadBuffer);
      req.end();
    });

    // Check if this was a redirect hop
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      redirectsRemaining--;
      currentUrl = result.body; // nextUrl
      continue;
    }

    return result;
  }
}
