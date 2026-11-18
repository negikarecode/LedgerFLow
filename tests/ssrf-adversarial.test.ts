import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import https from 'https';
import net from 'net';
import dns from 'dns';
import {
  isPrivateOrBlockedIP,
  isPrivateOrBlockedIPv4Octets,
  isPrivateOrBlockedIPv6Words,
  parseIPv6Words,
  parseUnusualIPv4,
  validateWebhookPort,
  validateWebhookUrl,
  dispatchSecureWebhook,
  SSRFError,
  FORBIDDEN_PORTS,
  ALLOWED_PRODUCTION_PORTS,
  BLOCKED_METADATA_HOSTNAMES,
} from '../src/security/ssrf';

describe('Adversarial SSRF Security Audit Suite', () => {
  describe('1. IPv4 Range & Cloud Metadata Classification', () => {
    it('should block RFC 1918 private network ranges', () => {
      // 10.0.0.0/8
      expect(isPrivateOrBlockedIP('10.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('10.255.255.255')).toBe(true);
      // 172.16.0.0/12
      expect(isPrivateOrBlockedIP('172.16.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('172.31.255.255')).toBe(true);
      expect(isPrivateOrBlockedIP('172.15.255.255')).toBe(false); // Public
      expect(isPrivateOrBlockedIP('172.32.0.1')).toBe(false); // Public
      // 192.168.0.0/16
      expect(isPrivateOrBlockedIP('192.168.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('192.168.255.255')).toBe(true);
    });

    it('should block loopback and current network ranges', () => {
      // 127.0.0.0/8
      expect(isPrivateOrBlockedIP('127.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('127.0.0.254')).toBe(true);
      expect(isPrivateOrBlockedIP('127.127.127.127')).toBe(true);
      // 0.0.0.0/8
      expect(isPrivateOrBlockedIP('0.0.0.0')).toBe(true);
      expect(isPrivateOrBlockedIP('0.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('0.255.255.255')).toBe(true);
    });

    it('should block all major cloud metadata IPs (AWS, GCP, Azure, Alibaba, Oracle, DO)', () => {
      // 169.254.169.254 (AWS IMDSv1/v2, GCP, Azure, Oracle, DigitalOcean)
      expect(isPrivateOrBlockedIP('169.254.169.254')).toBe(true);
      expect(isPrivateOrBlockedIP('169.254.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('169.254.255.254')).toBe(true);

      // 168.63.129.16 (Azure WireServer / Host GA platform IP)
      expect(isPrivateOrBlockedIP('168.63.129.16')).toBe(true);

      // 100.100.100.200 (Alibaba Cloud ECS metadata inside CGNAT 100.64.0.0/10)
      expect(isPrivateOrBlockedIP('100.100.100.200')).toBe(true);
      expect(isPrivateOrBlockedIP('100.64.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('100.127.255.255')).toBe(true);
      expect(isPrivateOrBlockedIP('100.63.255.255')).toBe(false); // Outside CGNAT
      expect(isPrivateOrBlockedIP('100.128.0.0')).toBe(false); // Outside CGNAT
    });

    it('should block test-nets, documentation, benchmarking, and multicast/broadcast', () => {
      // TEST-NET-1 (192.0.2.0/24)
      expect(isPrivateOrBlockedIP('192.0.2.1')).toBe(true);
      // TEST-NET-2 (198.51.100.0/24)
      expect(isPrivateOrBlockedIP('198.51.100.1')).toBe(true);
      // TEST-NET-3 (203.0.113.0/24)
      expect(isPrivateOrBlockedIP('203.0.113.1')).toBe(true);
      // Benchmarking (198.18.0.0/15)
      expect(isPrivateOrBlockedIP('198.18.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('198.19.255.255')).toBe(true);
      // 6to4 Relay (192.88.99.0/24)
      expect(isPrivateOrBlockedIP('192.88.99.1')).toBe(true);
      // Multicast & Reserved (224.0.0.0/4 and 240.0.0.0/4)
      expect(isPrivateOrBlockedIP('224.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('239.255.255.255')).toBe(true);
      expect(isPrivateOrBlockedIP('240.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('255.255.255.255')).toBe(true);

      // Legitimate Public IPs
      expect(isPrivateOrBlockedIP('8.8.8.8')).toBe(false);
      expect(isPrivateOrBlockedIP('1.1.1.1')).toBe(false);
      expect(isPrivateOrBlockedIP('93.184.216.34')).toBe(false);
    });
  });

  describe('2. IPv6 Range & IPv6 Cloud Metadata Classification', () => {
    it('should block IPv6 loopback in all standard and leading-zero forms', () => {
      expect(isPrivateOrBlockedIP('::1')).toBe(true);
      expect(isPrivateOrBlockedIP('[::1]')).toBe(true);
      expect(isPrivateOrBlockedIP('0:0:0:0:0:0:0:1')).toBe(true);
      expect(isPrivateOrBlockedIP('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true);
      expect(isPrivateOrBlockedIP('0::1')).toBe(true);
    });

    it('should block IPv6 unspecified in all forms', () => {
      expect(isPrivateOrBlockedIP('::')).toBe(true);
      expect(isPrivateOrBlockedIP('[::]')).toBe(true);
      expect(isPrivateOrBlockedIP('0:0:0:0:0:0:0:0')).toBe(true);
      expect(isPrivateOrBlockedIP('0::0')).toBe(true);
      expect(isPrivateOrBlockedIP('::0')).toBe(true);
    });

    it('should block IPv4-mapped IPv6 in both dotted and hex representations', () => {
      // Dotted IPv4-mapped IPv6
      expect(isPrivateOrBlockedIP('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateOrBlockedIP('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('::ffff:168.63.129.16')).toBe(true);
      expect(isPrivateOrBlockedIP('::ffff:8.8.8.8')).toBe(false); // Public IPv4 mapped

      // Pure Hex IPv4-mapped IPv6
      expect(isPrivateOrBlockedIP('::ffff:7f00:1')).toBe(true); // 127.0.0.1 in hex
      expect(isPrivateOrBlockedIP('::ffff:7f00:0001')).toBe(true);
      expect(isPrivateOrBlockedIP('0:0:0:0:0:ffff:7f00:1')).toBe(true);
      expect(isPrivateOrBlockedIP('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254 in hex
      expect(isPrivateOrBlockedIP('::ffff:0808:0808')).toBe(false); // 8.8.8.8 in hex (public)
    });

    it('should block deprecated IPv4-compatible IPv6 addresses', () => {
      expect(isPrivateOrBlockedIP('::127.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('::7f00:1')).toBe(true);
      expect(isPrivateOrBlockedIP('0:0:0:0:0:0:7f00:1')).toBe(true);
    });

    it('should block Unique Local Addresses (ULA) including AWS IMDSv6', () => {
      expect(isPrivateOrBlockedIP('fc00::1')).toBe(true);
      expect(isPrivateOrBlockedIP('fd00::1')).toBe(true);
      // AWS EC2 IMDSv6 metadata endpoint
      expect(isPrivateOrBlockedIP('fd00:ec2::254')).toBe(true);
      expect(isPrivateOrBlockedIP('[fd00:ec2::254]')).toBe(true);
    });

    it('should block Link-Local, Site-Local, Multicast, and Documentation IPv6', () => {
      // Link-Local (fe80::/10) with and without zone ID
      expect(isPrivateOrBlockedIP('fe80::1')).toBe(true);
      expect(isPrivateOrBlockedIP('fe80::1%eth0')).toBe(true);
      expect(isPrivateOrBlockedIP('fe80::1%1')).toBe(true);
      expect(isPrivateOrBlockedIP('febf::1')).toBe(true);

      // Site-Local (fec0::/10 deprecated RFC 3879)
      expect(isPrivateOrBlockedIP('fec0::1')).toBe(true);
      expect(isPrivateOrBlockedIP('feff::1')).toBe(true);

      // Multicast (ff00::/8)
      expect(isPrivateOrBlockedIP('ff02::1')).toBe(true);
      expect(isPrivateOrBlockedIP('ff05::2')).toBe(true);

      // Documentation (2001:db8::/32) and Benchmarking (2001:2::/48)
      expect(isPrivateOrBlockedIP('2001:db8::1')).toBe(true);
      expect(isPrivateOrBlockedIP('2001:2::1')).toBe(true);

      // 6to4 and Teredo
      expect(isPrivateOrBlockedIP('2002:7f00:1::')).toBe(true);
      expect(isPrivateOrBlockedIP('2001:0000::1')).toBe(true);

      // Public routable IPv6
      expect(isPrivateOrBlockedIP('2607:f8b0:4005:805::200e')).toBe(false);
    });
  });

  describe('3. Unusual IP & Parser Representations in URLs', () => {
    it('should parse and block decimal integer IP representations', async () => {
      // 2130706433 = 127.0.0.1
      expect(parseUnusualIPv4('2130706433')).toEqual([127, 0, 0, 1]);
      expect(isPrivateOrBlockedIP('2130706433')).toBe(true);

      await expect(
        validateWebhookUrl('http://2130706433/hook', { allowPrivate: false, requireHttps: false })
      ).rejects.toThrow(SSRFError);
    });

    it('should parse and block hexadecimal IP representations', async () => {
      // 0x7f000001 = 127.0.0.1
      expect(parseUnusualIPv4('0x7f000001')).toEqual([127, 0, 0, 1]);
      expect(isPrivateOrBlockedIP('0x7f000001')).toBe(true);

      await expect(
        validateWebhookUrl('http://0x7f000001/hook', { allowPrivate: false, requireHttps: false })
      ).rejects.toThrow(SSRFError);
    });

    it('should parse and block octal IP representations', async () => {
      // 0177.0.0.1 = 127.0.0.1
      expect(parseUnusualIPv4('0177.0.0.1')).toEqual([127, 0, 0, 1]);
      expect(isPrivateOrBlockedIP('0177.0.0.1')).toBe(true);

      await expect(
        validateWebhookUrl('http://0177.0.0.1/hook', { allowPrivate: false, requireHttps: false })
      ).rejects.toThrow(SSRFError);
    });

    it('should parse and block shorthand and dotted-hex IP representations', async () => {
      // 127.1 = 127.0.0.1
      expect(parseUnusualIPv4('127.1')).toEqual([127, 0, 0, 1]);
      expect(isPrivateOrBlockedIP('127.1')).toBe(true);

      // 0x7f.1 = 127.0.0.1
      expect(parseUnusualIPv4('0x7f.1')).toEqual([127, 0, 0, 1]);
      expect(isPrivateOrBlockedIP('0x7f.1')).toBe(true);
    });

    it('should reject URLs with embedded user credentials', async () => {
      await expect(
        validateWebhookUrl('https://user:password@example.com/webhook')
      ).rejects.toThrow(/embedded user credentials/i);

      await expect(
        validateWebhookUrl('https://user@example.com/webhook')
      ).rejects.toThrow(/embedded user credentials/i);

      await expect(
        validateWebhookUrl('https://:password@example.com/webhook')
      ).rejects.toThrow(/embedded user credentials/i);
    });

    it('should reject non-HTTP/HTTPS protocols', async () => {
      await expect(validateWebhookUrl('file:///etc/passwd')).rejects.toThrow(/unsupported protocol/i);
      await expect(validateWebhookUrl('gopher://127.0.0.1:6379/_')).rejects.toThrow(/unsupported protocol/i);
      await expect(validateWebhookUrl('ftp://example.com/resource')).rejects.toThrow(/unsupported protocol/i);
      await expect(validateWebhookUrl('javascript:alert(1)')).rejects.toThrow(/unsupported protocol/i);
      await expect(validateWebhookUrl('data:text/html,test')).rejects.toThrow(/unsupported protocol/i);
    });

    it('should reject cloud metadata hostnames immediately', async () => {
      await expect(
        validateWebhookUrl('http://metadata.google.internal/computeMetadata/v1/')
      ).rejects.toThrow(/reserved cloud metadata endpoint/i);

      await expect(
        validateWebhookUrl('http://metadata/latest/meta-data/')
      ).rejects.toThrow(/reserved cloud metadata endpoint/i);

      await expect(
        validateWebhookUrl('http://instance-data/latest/meta-data/')
      ).rejects.toThrow(/reserved cloud metadata endpoint/i);
    });

    it('should reject internal and reserved domain suffixes', async () => {
      await expect(
        validateWebhookUrl('http://service.internal/webhook', { allowPrivate: false, requireHttps: false })
      ).rejects.toThrow(/internal or reserved domain name/i);

      await expect(
        validateWebhookUrl('http://host.local/webhook', { allowPrivate: false, requireHttps: false })
      ).rejects.toThrow(/internal or reserved domain name/i);

      await expect(
        validateWebhookUrl('http://app.localhost/webhook', { allowPrivate: false, requireHttps: false })
      ).rejects.toThrow(/internal or reserved domain name/i);
    });
  });

  describe('4. Port Policy & Restriction Enforcement', () => {
    it('should block known sensitive infrastructure and database ports', () => {
      // Databases
      expect(() => validateWebhookPort('5432', 'https:', false)).toThrow(/restricted/i);
      expect(() => validateWebhookPort('6379', 'https:', false)).toThrow(/restricted/i);
      expect(() => validateWebhookPort('3306', 'https:', false)).toThrow(/restricted/i);
      expect(() => validateWebhookPort('27017', 'https:', false)).toThrow(/restricted/i);

      // System / Admin
      expect(() => validateWebhookPort('22', 'https:', false)).toThrow(/restricted/i);
      expect(() => validateWebhookPort('25', 'https:', false)).toThrow(/restricted/i);
      expect(() => validateWebhookPort('2375', 'https:', false)).toThrow(/restricted/i);
      expect(() => validateWebhookPort('6443', 'https:', false)).toThrow(/restricted/i);
      expect(() => validateWebhookPort('8500', 'https:', false)).toThrow(/restricted/i);
    });

    it('should reject invalid or out-of-range ports', () => {
      expect(() => validateWebhookPort('0', 'https:', false)).toThrow(/restricted|invalid/i);
      expect(() => validateWebhookPort('-1', 'https:', false)).toThrow(/invalid/i);
      expect(() => validateWebhookPort('70000', 'https:', false)).toThrow(/invalid/i);
      expect(() => validateWebhookPort('abc', 'https:', false)).toThrow(/invalid/i);
    });

    it('should restrict production webhooks strictly to ports 443 and 8443', () => {
      // Allowed in production
      expect(validateWebhookPort('443', 'https:', true)).toBe(443);
      expect(validateWebhookPort('8443', 'https:', true)).toBe(8443);
      expect(validateWebhookPort('', 'https:', true)).toBe(443);

      // Blocked in production
      expect(() => validateWebhookPort('80', 'http:', true)).toThrow(/not permitted in production/i);
      expect(() => validateWebhookPort('8080', 'https:', true)).toThrow(/not permitted in production/i);
      expect(() => validateWebhookPort('3000', 'https:', true)).toThrow(/not permitted in production/i);
    });
  });

  describe('5. Delivery-Time DNS Rebinding Defense & Socket Pinning', () => {
    let mockServer: http.Server;
    let mockPort: number;

    beforeAll(async () => {
      mockServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true, host: req.headers.host }));
      });
      await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
      mockPort = (mockServer.address() as net.AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });

    it('should pin the socket connection to the pre-validated IP address', async () => {
      // When allowPrivate is true in test mode, dispatchSecureWebhook connects to the pinned IP
      const res = await dispatchSecureWebhook({
        url: `http://127.0.0.1:${mockPort}/test-pinning`,
        payload: JSON.stringify({ event: 'test' }),
        allowPrivate: true,
      });

      expect(res.statusCode).toBe(200);
      const parsedBody = JSON.parse(res.body);
      expect(parsedBody.received).toBe(true);
    });

    it('should re-evaluate and reject if DNS rebinding attempts to target a private IP at delivery time', async () => {
      // Even if a URL was somehow registered earlier, dispatchSecureWebhook calls validateWebhookUrl
      // at delivery time. If the domain resolves to 127.0.0.1, it throws SSRFError immediately.
      await expect(
        dispatchSecureWebhook({
          url: `http://localhost:${mockPort}/delivery-time-rebinding`,
          payload: JSON.stringify({ test: true }),
          allowPrivate: false,
        })
      ).rejects.toThrow(SSRFError);
    });
  });

  describe('6. Redirect Security & Hop-by-Hop Validation', () => {
    let redirectServer: http.Server;
    let redirectPort: number;

    beforeAll(async () => {
      redirectServer = http.createServer((req, res) => {
        const url = new URL(req.url || '/', `http://127.0.0.1:${redirectPort}`);

        if (url.pathname === '/redirect-to-metadata') {
          res.writeHead(302, { Location: 'http://169.254.169.254/secret' });
          res.end();
        } else if (url.pathname === '/redirect-to-loopback') {
          res.writeHead(301, { Location: `http://127.0.0.1:${redirectPort}/final` });
          res.end();
        } else if (url.pathname === '/redirect-loop-a') {
          res.writeHead(302, { Location: `http://127.0.0.1:${redirectPort}/redirect-loop-b` });
          res.end();
        } else if (url.pathname === '/redirect-loop-b') {
          res.writeHead(302, { Location: `http://127.0.0.1:${redirectPort}/redirect-loop-a` });
          res.end();
        } else if (url.pathname === '/redirect-downgrade') {
          res.writeHead(302, { Location: 'http://example.com/unencrypted' });
          res.end();
        } else if (url.pathname === '/redirect-with-creds') {
          res.writeHead(302, { Location: 'https://admin:pass@example.com/hook' });
          res.end();
        } else if (url.pathname === '/redirect-protocol-relative') {
          res.writeHead(302, { Location: '//169.254.169.254/credentials' });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      });

      await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', () => resolve()));
      redirectPort = (redirectServer.address() as net.AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
    });

    it('should reject redirect targeting cloud metadata IP 169.254.169.254', async () => {
      await expect(
        dispatchSecureWebhook({
          url: `http://127.0.0.1:${redirectPort}/redirect-to-metadata`,
          payload: '{}',
          allowPrivate: true, // Allow initial hop, but second hop is metadata
        })
      ).rejects.toThrow(/private, loopback, or reserved/i);
    });

    it('should reject redirect loop when maxRedirects is exceeded', async () => {
      await expect(
        dispatchSecureWebhook({
          url: `http://127.0.0.1:${redirectPort}/redirect-loop-a`,
          payload: '{}',
          maxRedirects: 3,
          allowPrivate: true,
        })
      ).rejects.toThrow(/maximum redirect hops exceeded/i);
    });

    it('should reject redirect with embedded user credentials', async () => {
      await expect(
        dispatchSecureWebhook({
          url: `http://127.0.0.1:${redirectPort}/redirect-with-creds`,
          payload: '{}',
          allowPrivate: true,
        })
      ).rejects.toThrow(/embedded user credentials/i);
    });

    it('should reject protocol-relative redirect to metadata IP', async () => {
      await expect(
        dispatchSecureWebhook({
          url: `http://127.0.0.1:${redirectPort}/redirect-protocol-relative`,
          payload: '{}',
          allowPrivate: true,
        })
      ).rejects.toThrow(/private, loopback, or reserved/i);
    });
  });

  describe('7. Timeouts & Response Body Guards', () => {
    let slowServer: http.Server;
    let slowPort: number;

    beforeAll(async () => {
      slowServer = http.createServer((req, res) => {
        const url = req.url || '/';
        if (url === '/hang') {
          // Never respond - simulate blackhole / slow response
        } else if (url === '/huge-content-length') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': '10485760', // 10 MB Content-Length header
          });
          res.write('{"start":true}');
          // Keep open without ending
        } else if (url === '/stream-overflow') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          // Send 70 KB in chunks (exceeds 64 KB limit)
          const chunk = 'A'.repeat(1024);
          for (let i = 0; i < 70; i++) {
            res.write(chunk);
          }
          res.end();
        } else {
          res.writeHead(200);
          res.end('OK');
        }
      });

      await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', () => resolve()));
      slowPort = (slowServer.address() as net.AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    });

    it('should abort cleanly on total request timeout', async () => {
      await expect(
        dispatchSecureWebhook({
          url: `http://127.0.0.1:${slowPort}/hang`,
          payload: '{}',
          timeoutMs: 300,
          allowPrivate: true,
        })
      ).rejects.toThrow(/timeout|timed out/i);
    });

    it('should immediately reject response when Content-Length header exceeds limit', async () => {
      await expect(
        dispatchSecureWebhook({
          url: `http://127.0.0.1:${slowPort}/huge-content-length`,
          payload: '{}',
          maxResponseBytes: 65536,
          allowPrivate: true,
        })
      ).rejects.toThrow(/exceeds maximum allowed limit/i);
    });

    it('should abort and destroy socket when streamed chunks exceed maximum response bytes', async () => {
      await expect(
        dispatchSecureWebhook({
          url: `http://127.0.0.1:${slowPort}/stream-overflow`,
          payload: '{}',
          maxResponseBytes: 65536,
          allowPrivate: true,
        })
      ).rejects.toThrow(/exceeded maximum allowed limit of 65536 bytes/i);
    });
  });

  describe('8. Production Lockdown & Security Invariants', () => {
    it('should force allowPrivate = false in validateWebhookUrl when NODE_ENV is production', async () => {
      const origEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        // Even if caller explicitly passes allowPrivate: true, production forces it to false
        await expect(
          validateWebhookUrl('https://127.0.0.1/hook', { allowPrivate: true })
        ).rejects.toThrow(/private, loopback, or reserved/i);

        await expect(
          validateWebhookUrl('https://169.254.169.254/latest', { allowPrivate: true })
        ).rejects.toThrow(/private, loopback, or reserved/i);
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it('should force allowPrivate = false in dispatchSecureWebhook when NODE_ENV is production', async () => {
      const origEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        await expect(
          dispatchSecureWebhook({
            url: 'https://127.0.0.1/hook',
            payload: '{}',
            allowPrivate: true,
          })
        ).rejects.toThrow(/private, loopback, or reserved/i);
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it('should strictly enforce HTTPS in production', async () => {
      const origEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        await expect(
          validateWebhookUrl('http://example.com/webhook')
        ).rejects.toThrow(/HTTPS is strictly required/i);
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });
  });
});
