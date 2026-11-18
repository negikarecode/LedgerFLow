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
 * Ports known to be used by sensitive internal services, databases,
 * administrative interfaces, or protocols that should NEVER be targets of webhooks.
 */
export const FORBIDDEN_PORTS = new Set<number>([
  0,     // Invalid / reserved
  21,    // FTP
  22,    // SSH
  23,    // Telnet
  25,    // SMTP
  53,    // DNS
  67, 68,// DHCP
  69,    // TFTP
  110,   // POP3
  119,   // NNTP
  123,   // NTP
  135, 137, 138, 139, // NetBIOS
  143,   // IMAP
  161, 162, // SNMP
  389, 636, // LDAP / LDAPS
  445,   // SMB
  1433,  // MSSQL
  1521,  // Oracle
  2375, 2376, // Docker Daemon
  2379, 2380, // etcd
  3306,  // MySQL
  5432,  // PostgreSQL
  6379,  // Redis
  6443,  // Kubernetes API
  8500,  // Consul
  9090,  // Prometheus
  9092,  // Kafka
  9200, 9300, // Elasticsearch
  10250, 10255, // Kubelet
  11211, // Memcached
  27017, // MongoDB
]);

/**
 * Standard allowed ports in production:
 * Webhooks must target standard secure web ports.
 */
export const ALLOWED_PRODUCTION_PORTS = new Set<number>([
  443,   // Standard HTTPS
  8443,  // Standard Alternative HTTPS
]);

/**
 * Known internal cloud metadata hostnames that should never be accessed.
 */
export const BLOCKED_METADATA_HOSTNAMES = new Set<string>([
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'metadata.tencentyun.com',
]);

/**
 * Checks whether an IP address belongs to cloud provider metadata services
 * (AWS, GCP, Azure, Alibaba, Oracle, DigitalOcean).
 * Cloud metadata access is strictly forbidden in all environments without exception.
 */
export function isCloudMetadataIP(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false;
  let trimmed = ip.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    trimmed = trimmed.slice(1, -1);
  }

  // 169.254.0.0/16: Link-Local & Cloud Metadata (AWS IMDSv1/v2, GCP, Azure, Oracle, DO)
  if (trimmed === '169.254.169.254' || trimmed.startsWith('169.254.')) return true;

  // 168.63.129.16: Azure WireServer / Host GA IMDS
  if (trimmed === '168.63.129.16') return true;

  // 100.100.100.200: Alibaba Cloud ECS metadata
  if (trimmed === '100.100.100.200') return true;

  // fd00:ec2::254: AWS EC2 IPv6 IMDSv6
  if (trimmed === 'fd00:ec2::254') return true;

  // IPv4-mapped IPv6 forms (e.g. ::ffff:169.254.169.254 or ::ffff:a9fe:a9fe)
  if (trimmed.startsWith('::ffff:')) {
    const rest = trimmed.slice(7);
    if (net.isIP(rest) === 4) {
      return isCloudMetadataIP(rest);
    }
  }

  // Word-level check for IPv6 representation of metadata
  const words = parseIPv6Words(trimmed);
  if (words) {
    // fd00:ec2::254
    if (words[0] === 0xfd00 && words[1] === 0x0ec2 && words[7] === 0x0254) return true;
    // ::ffff:169.254.169.254 -> w5 = 0xffff, w6 = 0xa9fe, w7 = 0xa9fe
    if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff) {
      if (words[6] === 0xa9fe && words[7] === 0xa9fe) return true;
    }
  }

  return false;
}

/**
 * Checks whether 4 IPv4 octets belong to private, loopback, link-local,
 * cloud metadata, CGNAT, broadcast, or reserved network ranges.
 */
export function isPrivateOrBlockedIPv4Octets(o0: number, o1: number, o2: number, o3: number): boolean {
  // 0.0.0.0/8: Current network (RFC 1122)
  if (o0 === 0) return true;

  // 10.0.0.0/8: Private network (RFC 1918)
  if (o0 === 10) return true;

  // 100.64.0.0/10: Carrier-Grade NAT (RFC 6598: 100.64.0.0 - 100.127.255.255)
  // Also covers Alibaba Cloud ECS metadata service at 100.100.100.200
  if (o0 === 100 && o1 >= 64 && o1 <= 127) return true;

  // 127.0.0.0/8: Loopback (RFC 1122)
  if (o0 === 127) return true;

  // 168.63.129.16: Azure WireServer / Host Agent IMDS
  if (o0 === 168 && o1 === 63 && o2 === 129 && o3 === 16) return true;

  // 169.254.0.0/16: Link-Local & Cloud Metadata (RFC 3927, includes 169.254.169.254)
  if (o0 === 169 && o1 === 254) return true;

  // 172.16.0.0/12: Private network (RFC 1918: 172.16.0.0 - 172.31.255.255)
  if (o0 === 172 && o1 >= 16 && o1 <= 31) return true;

  // 192.0.0.0/24: IETF Protocol Assignments (RFC 6890)
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

  // 224.0.0.0/4: Multicast (RFC 5771: 224.0.0.0 - 239.255.255.255)
  // 240.0.0.0/4: Reserved for future use (RFC 1112: 240.0.0.0 - 255.255.255.254)
  // 255.255.255.255: Broadcast
  if (o0 >= 224) return true;

  return false;
}

/**
 * Parses unusual IPv4 representations (single 32-bit integer, hex, octal, dotted shorthand).
 */
export function parseUnusualIPv4(ip: string): [number, number, number, number] | null {
  if (!ip || typeof ip !== 'string') return null;
  const trimmed = ip.trim();

  // 1. Single integer (decimal or hex, e.g. 2130706433 or 0x7f000001)
  if (/^(0x[0-9a-fA-F]+|\d+)$/.test(trimmed)) {
    const val = Number(trimmed);
    if (!isNaN(val) && val >= 0 && val <= 0xffffffff) {
      return [
        (val >>> 24) & 0xff,
        (val >>> 16) & 0xff,
        (val >>> 8) & 0xff,
        val & 0xff,
      ];
    }
  }

  // 2. Dotted notation with octal/hex/decimal parts (e.g. 0177.0.0.1, 0x7f.0.0.1, 127.1)
  const parts = trimmed.split('.');
  if (parts.length >= 2 && parts.length <= 4) {
    const octets: number[] = [];
    for (const part of parts) {
      let num = NaN;
      if (/^0x[0-9a-fA-F]+$/i.test(part)) {
        num = parseInt(part, 16);
      } else if (/^0[0-7]+$/.test(part)) {
        num = parseInt(part, 8);
      } else if (/^\d+$/.test(part)) {
        num = parseInt(part, 10);
      } else {
        return null;
      }
      if (isNaN(num) || num < 0) return null;
      octets.push(num);
    }

    if (octets.length === 2) {
      // Shorthand: A.B -> A.0.0.B
      return [octets[0], 0, 0, octets[1] & 0xff];
    } else if (octets.length === 3) {
      // Shorthand: A.B.C -> A.B.0.C
      return [octets[0], octets[1], 0, octets[2] & 0xff];
    } else if (octets.length === 4) {
      return octets.every((o) => o <= 255)
        ? [octets[0], octets[1], octets[2], octets[3]]
        : null;
    }
  }

  return null;
}

/**
 * Parses an IPv6 string into 8 16-bit words.
 * Handles bracketed forms, zone IDs, mixed IPv4 notation, and compressed zeros (::).
 */
export function parseIPv6Words(ip: string): number[] | null {
  if (!ip || typeof ip !== 'string') return null;
  let s = ip.trim().toLowerCase();

  // Strip outer brackets [::1]
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1);
  }

  // Strip zone index %eth0
  const zoneIndex = s.indexOf('%');
  if (zoneIndex !== -1) {
    s = s.slice(0, zoneIndex);
  }

  // Handle embedded IPv4 notation at tail (e.g. ::ffff:192.0.2.1 or ::192.0.2.1)
  let ipv4Words: [number, number] | null = null;
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1) {
    const tail = s.slice(lastColon + 1);
    if (tail.includes('.')) {
      const octets = tail.split('.');
      if (
        octets.length !== 4 ||
        !octets.every((o) => /^\d+$/.test(o) && Number(o) >= 0 && Number(o) <= 255)
      ) {
        return null; // Malformed IPv4 tail
      }
      const nums = octets.map(Number);
      ipv4Words = [(nums[0] << 8) | nums[1], (nums[2] << 8) | nums[3]];
      s = s.slice(0, lastColon);
      if (s === ':') s = '::';
    }
  }

  // Verify at most one '::'
  const doubleColonIndex = s.indexOf('::');
  if (doubleColonIndex !== -1 && s.indexOf('::', doubleColonIndex + 2) !== -1) {
    return null;
  }

  let headParts: string[] = [];
  let tailParts: string[] = [];
  if (doubleColonIndex !== -1) {
    const headStr = s.slice(0, doubleColonIndex);
    const tailStr = s.slice(doubleColonIndex + 2);
    headParts = headStr ? headStr.split(':') : [];
    tailParts = tailStr ? tailStr.split(':') : [];
  } else {
    headParts = s.split(':');
  }

  const expectedWords = ipv4Words ? 6 : 8;
  const totalGiven = headParts.length + tailParts.length;
  if (doubleColonIndex !== -1) {
    if (totalGiven > expectedWords) return null;
  } else {
    if (totalGiven !== expectedWords) return null;
  }

  const parseHex = (part: string): number | null =>
    /^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : null;

  const head: number[] = [];
  for (const p of headParts) {
    const v = parseHex(p);
    if (v === null) return null;
    head.push(v);
  }

  const tail: number[] = [];
  for (const p of tailParts) {
    const v = parseHex(p);
    if (v === null) return null;
    tail.push(v);
  }

  const missing = expectedWords - head.length - tail.length;
  const words = [...head, ...new Array(missing).fill(0), ...tail, ...(ipv4Words || [])];
  return words.length === 8 ? words : null;
}

/**
 * Checks whether 8 16-bit words of an IPv6 address belong to private, loopback,
 * link-local, multicast, ULA, documentation, 6to4, or reserved ranges.
 */
export function isPrivateOrBlockedIPv6Words(words: number[]): boolean {
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;

  // Unspecified (::)
  if (words.every((w) => w === 0)) return true;

  // Loopback (::1)
  if (
    w0 === 0 &&
    w1 === 0 &&
    w2 === 0 &&
    w3 === 0 &&
    w4 === 0 &&
    w5 === 0 &&
    w6 === 0 &&
    w7 === 1
  ) {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:0:0/96, both dotted and hex notations)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    const o0 = (w6 >> 8) & 0xff;
    const o1 = w6 & 0xff;
    const o2 = (w7 >> 8) & 0xff;
    const o3 = w7 & 0xff;
    return isPrivateOrBlockedIPv4Octets(o0, o1, o2, o3);
  }

  // IPv4-compatible IPv6 (deprecated ::/96)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return true; // Always block deprecated IPv4-compatible IPv6
  }

  // 6to4 (2002::/16 - RFC 3056, deprecated RFC 7526)
  if (w0 === 0x2002) {
    const o0 = (w1 >> 8) & 0xff;
    const o1 = w1 & 0xff;
    const o2 = (w2 >> 8) & 0xff;
    const o3 = w2 & 0xff;
    if (isPrivateOrBlockedIPv4Octets(o0, o1, o2, o3)) return true;
    return true; // Deprecated 6to4 relay prefix
  }

  // Teredo (2001:0000::/32 - RFC 4380)
  if (w0 === 0x2001 && w1 === 0x0000) {
    return true; // Block Teredo tunneling
  }

  // Unique Local Addresses (ULA - fc00::/7 covers fc00 to fdff, including AWS IMDSv6 fd00:ec2::254)
  if ((w0 & 0xfe00) === 0xfc00) return true;

  // Link-Local unicast (fe80::/10 covers fe80 to febf)
  if ((w0 & 0xffc0) === 0xfe80) return true;

  // Site-Local unicast (fec0::/10 covers fec0 to feff, deprecated RFC 3879)
  if ((w0 & 0xffc0) === 0xfec0) return true;

  // Multicast (ff00::/8 covers ff00 to ffff)
  if ((w0 & 0xff00) === 0xff00) return true;

  // Documentation (2001:db8::/32)
  if (w0 === 0x2001 && w1 === 0x0db8) return true;

  // Benchmarking (2001:2::/48)
  if (w0 === 0x2001 && w1 === 0x0002) return true;

  // Discard prefix (100::/64)
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return true;

  return false;
}

/**
 * Checks whether an IP address (IPv4 or IPv6, in standard or unusual format)
 * belongs to a private, loopback, link-local, cloud-metadata, CGNAT, or reserved network range.
 */
export function isPrivateOrBlockedIP(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return true;

  let trimmed = ip.trim().toLowerCase();

  // Strip outer brackets if present: [::1] -> ::1
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    trimmed = trimmed.slice(1, -1);
  }

  // Strip zone index: fe80::1%eth0 -> fe80::1
  const zoneIdx = trimmed.indexOf('%');
  if (zoneIdx !== -1) {
    trimmed = trimmed.slice(0, zoneIdx);
  }

  // 1. Standard IPv4
  const family = net.isIP(trimmed);
  if (family === 4) {
    const octets = trimmed.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => isNaN(n) || n < 0 || n > 255)) {
      return true; // Malformed IPv4
    }
    return isPrivateOrBlockedIPv4Octets(octets[0], octets[1], octets[2], octets[3]);
  }

  // 2. IPv6 (standard, compressed, mixed IPv4, or bracketed)
  const ipv6Words = parseIPv6Words(trimmed);
  if (ipv6Words) {
    return isPrivateOrBlockedIPv6Words(ipv6Words);
  }

  // 3. Unusual IPv4 formats (e.g. 2130706433, 0x7f000001, 0177.0.0.1, 127.1)
  const unusualOctets = parseUnusualIPv4(trimmed);
  if (unusualOctets) {
    return isPrivateOrBlockedIPv4Octets(
      unusualOctets[0],
      unusualOctets[1],
      unusualOctets[2],
      unusualOctets[3]
    );
  }

  // Unparseable IP is blocked by default (fail closed)
  return true;
}

/**
 * Validates the port of a webhook destination URL according to environment policy.
 */
export function validateWebhookPort(
  portStr: string,
  protocol: string,
  isProduction: boolean
): number {
  let port: number;
  if (!portStr) {
    port = protocol === 'https:' ? 443 : 80;
  } else {
    port = parseInt(portStr, 10);
  }

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new SSRFError(
      `Invalid port '${portStr}'. Destination port must be an integer between 1 and 65535.`
    );
  }

  if (FORBIDDEN_PORTS.has(port)) {
    throw new SSRFError(
      `Port ${port} is restricted and cannot be used for webhook destinations.`
    );
  }

  if (isProduction && !ALLOWED_PRODUCTION_PORTS.has(port)) {
    throw new SSRFError(
      `Port ${port} is not permitted in production. Webhooks in production must target standard port 443 or 8443.`
    );
  }

  return port;
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
 * - Enforces port whitelist & blocks sensitive/database service ports.
 * - Blocks cloud metadata hostnames.
 * - Resolves DNS and asserts that NO resolved IP is in loopback, private, link-local,
 *   metadata, ULA, or CGNAT ranges.
 * - Pins the first safe resolved IP address for delivery.
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
    throw new SSRFError(
      `Unsupported protocol '${parsed.protocol}'. Only HTTP and HTTPS are permitted.`
    );
  }

  const isProduction =
    process.env.NODE_ENV === 'production' || env.NODE_ENV === 'production';
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

  // In production, private webhook targets are strictly forbidden under all circumstances
  const allowPrivate = isProduction
    ? false
    : (options?.allowPrivate ??
      (process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === 'true' ||
        env.ALLOW_PRIVATE_WEBHOOK_TARGETS));

  // Validate port
  validateWebhookPort(parsed.port, parsed.protocol, isProduction);

  // Reject known cloud metadata hostnames under ALL circumstances (even in dev/demo mode)
  const normalizedHost = hostname.toLowerCase();
  if (BLOCKED_METADATA_HOSTNAMES.has(normalizedHost)) {
    throw new SSRFError(
      `Host '${hostname}' is a reserved cloud metadata endpoint. Connection refused for SSRF protection.`
    );
  }

  // 1. Literal IP check (strip outer brackets for IPv6)
  const cleanHost =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;

  // Cloud metadata IPs are strictly forbidden under ALL circumstances without exception
  if (isCloudMetadataIP(cleanHost)) {
    throw new SSRFError(
      `Target IP address '${hostname}' is private, loopback, or reserved.`
    );
  }

  // Check for internal/reserved domain suffixes in production or when private targets disabled
  if (!allowPrivate) {
    if (
      normalizedHost.endsWith('.internal') ||
      normalizedHost.endsWith('.local') ||
      normalizedHost.endsWith('.localhost') ||
      normalizedHost.endsWith('.onion')
    ) {
      throw new SSRFError(
        `Host '${hostname}' is an internal or reserved domain name. Connection refused for SSRF protection.`
      );
    }
  }

  // If private targets are explicitly allowed (dev/test only), bypass local loopback/private checks
  if (allowPrivate) {
    return {
      url: parsed,
      resolvedIps: [],
    };
  }

  if (net.isIP(cleanHost) || parseIPv6Words(cleanHost) || parseUnusualIPv4(cleanHost)) {
    if (isPrivateOrBlockedIP(cleanHost)) {
      throw new SSRFError(
        `Target IP address '${hostname}' is private, loopback, or reserved.`
      );
    }
    return {
      url: parsed,
      resolvedIps: [cleanHost],
      pinnedIp: cleanHost,
    };
  }

  // 2. DNS resolution check (reject if ANY resolved address is private/blocked)
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(cleanHost, { all: true });
  } catch (err: any) {
    throw new SSRFError(`DNS resolution failed for host '${cleanHost}': ${err.message}`);
  }

  if (!addresses || addresses.length === 0) {
    throw new SSRFError(`Host '${cleanHost}' did not resolve to any IP addresses.`);
  }

  const resolvedIps = addresses.map((a) => a.address);

  for (const ip of resolvedIps) {
    if (isPrivateOrBlockedIP(ip)) {
      throw new SSRFError(
        `Host '${cleanHost}' resolves to blocked/private address '${ip}'. Connection refused for SSRF protection.`
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
  connectionTimeoutMs?: number;
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
 * 3. Supports standard TLS SNI hostname verification against the original hostname.
 * 4. Inspects and re-validates redirects at each hop (rejects redirects to private IPs or downgraded schemes).
 * 5. Enforces connection, read, and total request timeouts with guaranteed cleanup.
 * 6. Limits response body size with upfront Content-Length and streaming buffer guards.
 */
export async function dispatchSecureWebhook(
  options: SecureWebhookOptions
): Promise<SecureWebhookResponse> {
  const isProduction =
    process.env.NODE_ENV === 'production' || env.NODE_ENV === 'production';

  const {
    url,
    payload,
    headers = {},
    timeoutMs = 5000,
    connectionTimeoutMs = 3000,
    maxResponseBytes = 65536, // 64 KB
    maxRedirects = 3,
    allowPrivate = isProduction
      ? false
      : (options.allowPrivate ??
        (process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === 'true' ||
          env.ALLOW_PRIVATE_WEBHOOK_TARGETS)),
  } = options;

  let currentUrl = url;
  let redirectsRemaining = maxRedirects;

  while (true) {
    // 1. Re-validate destination URL at delivery time
    const validation = await validateWebhookUrl(currentUrl, {
      allowPrivate: isProduction ? false : allowPrivate,
    });
    const parsedUrl = validation.url;
    const isHttps = parsedUrl.protocol === 'https:';

    // 2. Pin IP address to defeat DNS rebinding
    let pinnedIp = validation.pinnedIp;
    if (!pinnedIp && allowPrivate) {
      try {
        const lookup = await dns.promises.lookup(parsedUrl.hostname);
        pinnedIp = lookup.address;
      } catch {
        pinnedIp = parsedUrl.hostname;
      }
    }

    const payloadBuffer = Buffer.from(payload, 'utf8');

    // Create a custom agent lookup that forces socket connection exclusively to the pinned IP
    const agentLookup: http.AgentOptions['lookup'] = (
      _hostname: string,
      opts: any,
      callback: any
    ) => {
      let cb = callback;
      let lookupOpts = opts;
      if (typeof opts === 'function') {
        cb = opts;
        lookupOpts = {};
      }
      const family = net.isIP(pinnedIp || '') || 4;
      if (lookupOpts && lookupOpts.all) {
        cb(null, [{ address: pinnedIp || _hostname, family }]);
      } else {
        cb(null, pinnedIp || _hostname, family);
      }
    };

    const agentOptions = pinnedIp && net.isIP(pinnedIp) ? { lookup: agentLookup } : {};
    const agent = isHttps ? new https.Agent(agentOptions) : new http.Agent(agentOptions);

    const cleanHostname =
      parsedUrl.hostname.startsWith('[') && parsedUrl.hostname.endsWith(']')
        ? parsedUrl.hostname.slice(1, -1)
        : parsedUrl.hostname;

    const requestOptions: https.RequestOptions = {
      protocol: parsedUrl.protocol,
      hostname: cleanHostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      agent,
      // For HTTPS, preserve TLS SNI and hostname certificate validation
      ...(isHttps && !net.isIP(cleanHostname) ? { servername: cleanHostname } : {}),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payloadBuffer.length,
        Host: parsedUrl.host,
        ...headers,
      },
    };

    const result = await new Promise<SecureWebhookResponse>((resolve, reject) => {
      let isSettled = false;
      let totalTimer: NodeJS.Timeout | null = null;
      let connectTimer: NodeJS.Timeout | null = null;

      const cleanupTimers = () => {
        if (totalTimer) {
          clearTimeout(totalTimer);
          totalTimer = null;
        }
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      };

      const safeResolve = (res: SecureWebhookResponse) => {
        if (isSettled) return;
        isSettled = true;
        cleanupTimers();
        resolve(res);
      };

      const safeReject = (err: Error) => {
        if (isSettled) return;
        isSettled = true;
        cleanupTimers();
        reject(err);
      };

      const clientModule = isHttps ? https : http;
      const req = clientModule.request(requestOptions, (res) => {
        const statusCode = res.statusCode || 0;
        const statusText = res.statusMessage || '';

        // Handle Redirects (301, 302, 303, 307, 308)
        if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
          // Discard and destroy socket to prevent reading large redirect bodies
          req.destroy();

          if (redirectsRemaining <= 0) {
            safeReject(new SSRFError('Maximum redirect hops exceeded.'));
            return;
          }

          let nextUrl: string;
          try {
            nextUrl = new URL(res.headers.location, currentUrl).toString();
          } catch {
            safeReject(new SSRFError(`Malformed redirect location: '${res.headers.location}'`));
            return;
          }

          // Prevent protocol downgrade: HTTPS redirecting to plain HTTP
          if (isHttps && !nextUrl.startsWith('https:')) {
            safeReject(
              new SSRFError('Insecure redirect from HTTPS to HTTP is forbidden for SSRF protection.')
            );
            return;
          }

          safeResolve({
            statusCode,
            statusText: `Redirect -> ${nextUrl}`,
            body: nextUrl,
            headers: res.headers,
          });
          return;
        }

        // Check upfront Content-Length header to prevent large buffer allocations
        const contentLengthHeader = res.headers['content-length'];
        if (contentLengthHeader) {
          const cl = parseInt(contentLengthHeader, 10);
          if (!isNaN(cl) && cl > maxResponseBytes) {
            req.destroy();
            safeReject(
              new SSRFError(
                `Response Content-Length (${cl} bytes) exceeds maximum allowed limit of ${maxResponseBytes} bytes.`
              )
            );
            return;
          }
        }

        // Read response body with maximum size guard
        let receivedBytes = 0;
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxResponseBytes) {
            req.destroy();
            safeReject(
              new SSRFError(
                `Response body exceeded maximum allowed limit of ${maxResponseBytes} bytes.`
              )
            );
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          safeResolve({
            statusCode,
            statusText,
            body,
            headers: res.headers,
          });
        });
      });

      // 1. Connection Timeout
      req.on('socket', (socket: net.Socket) => {
        if (socket.connecting) {
          connectTimer = setTimeout(() => {
            if (!isSettled && socket.connecting) {
              req.destroy(
                new SSRFError(`Webhook connection timed out after ${connectionTimeoutMs}ms.`)
              );
            }
          }, connectionTimeoutMs);
          connectTimer.unref?.();

          socket.once('connect', () => {
            if (connectTimer) {
              clearTimeout(connectTimer);
              connectTimer = null;
            }
          });
        }
      });

      // 2. Read Inactivity Timeout
      req.setTimeout(timeoutMs, () => {
        req.destroy(new SSRFError(`Webhook read timed out after ${timeoutMs}ms.`));
      });

      // 3. Total Request Deadline Timeout
      totalTimer = setTimeout(() => {
        req.destroy(new SSRFError(`Webhook request exceeded total timeout of ${timeoutMs}ms.`));
      }, timeoutMs);
      totalTimer.unref?.();

      req.on('error', (err) => {
        safeReject(err);
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
