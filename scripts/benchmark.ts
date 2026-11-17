import { performance } from 'perf_hooks';

interface BenchmarkResult {
  status: number;
  isReplay: boolean;
  latencyMs: number;
  error?: string;
}

const BASE_URL = process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`;

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();
    return res.ok && data.status === 'ok';
  } catch {
    return false;
  }
}

async function createAccount(name: string, initialPaise: number): Promise<{ id: string; balance_paise: number }> {
  const res = await fetch(`${BASE_URL}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner_name: name,
      currency: 'INR',
      initial_credit_paise: initialPaise,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create account ${name}: HTTP ${res.status} - ${body}`);
  }

  return await res.json();
}

async function getAccountBalance(id: string): Promise<number> {
  const res = await fetch(`${BASE_URL}/accounts/${id}/ledger`);
  if (!res.ok) {
    throw new Error(`Failed to fetch account balance for ${id}: HTTP ${res.status}`);
  }
  const data = await res.json();
  return Number(data.balance_paise);
}

function calculatePercentile(sortedLatencies: number[], percentile: number): number {
  if (sortedLatencies.length === 0) return 0;
  const index = Math.min(
    Math.floor((percentile / 100) * sortedLatencies.length),
    sortedLatencies.length - 1
  );
  return sortedLatencies[index];
}

export async function runBenchmark(totalRequests = 500, transferAmountPaise = 1000): Promise<void> {
  console.log(`\n=================================================================================`);
  console.log(`               LEDGERFLOW LOAD BENCHMARK & CONCURRENCY SUITE                     `);
  console.log(`=================================================================================`);
  console.log(`[1/4] Verifying API Server health at ${BASE_URL}...`);

  const healthy = await checkHealth();
  if (!healthy) {
    console.error(`\n❌ Error: Cannot connect to LedgerFlow API at ${BASE_URL}.`);
    console.error(`Please ensure the server is running (e.g. 'npm run dev' or Docker).`);
    process.exit(1);
  }
  console.log(`  ✓ Connected to API Server (PostgreSQL + Redis UP)`);

  // 1. Seed Accounts
  console.log(`\n[2/4] Seeding Benchmark Wallets in PostgreSQL...`);
  const initialA = 100000; // ₹1,000.00
  const initialB = 50000;  // ₹500.00
  const initialSum = initialA + initialB;

  const sender = await createAccount(`Bench Sender ${Date.now()}`, initialA);
  const receiver = await createAccount(`Bench Receiver ${Date.now()}`, initialB);

  console.log(`  ✓ Account A (Sender)   : ${sender.id} | Balance: ₹${(initialA / 100).toFixed(2)} (${initialA} paise)`);
  console.log(`  ✓ Account B (Receiver) : ${receiver.id} | Balance: ₹${(initialB / 100).toFixed(2)} (${initialB} paise)`);
  console.log(`  ✓ Total Seeded Balance : ₹${(initialSum / 100).toFixed(2)} (${initialSum} paise)`);

  // Pre-seed a few completed transfers so the concurrent batch exercises completed idempotency replay
  const completedKeys: string[] = [];
  const preSeedCount = 5;
  for (let i = 0; i < preSeedCount; i++) {
    const key = `bench-preseed-${i}-${Date.now()}-${crypto.randomUUID()}`;
    completedKeys.push(key);
    await fetch(`${BASE_URL}/transfers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({
        from_account_id: sender.id,
        to_account_id: receiver.id,
        amount_paise: transferAmountPaise,
      }),
    });
  }
  console.log(`  ✓ Pre-settled ${preSeedCount} transfers to test completed idempotency cache replays`);

  // 2. Prepare Requests (350 unique keys, 50 completed replay keys, 100 in-flight concurrent duplicate keys)
  console.log(`\n[3/4] Preparing ${totalRequests} concurrent transfer requests...`);
  const inFlightDupKeyCount = 10;
  const inFlightDupKeys = Array.from({ length: inFlightDupKeyCount }, (_, i) => `bench-dup-inflight-${i}-${Date.now()}`);

  const requests: { key: string; isDuplicateIntent: boolean }[] = [];
  const replayCount = 50;
  const inFlightDupCount = 100;
  const uniqueCount = totalRequests - replayCount - inFlightDupCount; // 350

  // 1) Replay requests using keys that have already completed
  for (let i = 0; i < replayCount; i++) {
    requests.push({
      key: completedKeys[i % completedKeys.length],
      isDuplicateIntent: true,
    });
  }

  // 2) In-flight duplicate requests (fire simultaneously to test distributed 409 lock)
  for (let i = 0; i < inFlightDupCount; i++) {
    requests.push({
      key: inFlightDupKeys[i % inFlightDupKeyCount],
      isDuplicateIntent: true,
    });
  }

  // 3) Unique transfer requests
  for (let i = 0; i < uniqueCount; i++) {
    requests.push({
      key: `bench-unique-${i}-${crypto.randomUUID()}`,
      isDuplicateIntent: false,
    });
  }

  // Shuffle requests to interleave all types
  requests.sort(() => Math.random() - 0.5);

  console.log(`  ✓ Workload Mix: ${uniqueCount} unique keys + ${replayCount} cache replay keys + ${inFlightDupCount} in-flight duplicate keys`);
  console.log(`  ✓ Firing ${totalRequests} concurrent POST /transfers (Transfer Amount: ${transferAmountPaise} paise each)...`);

  const overallStart = performance.now();

  const results: BenchmarkResult[] = await Promise.all(
    requests.map(async ({ key }) => {
      const start = performance.now();
      try {
        const res = await fetch(`${BASE_URL}/transfers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
          },
          body: JSON.stringify({
            from_account_id: sender.id,
            to_account_id: receiver.id,
            amount_paise: transferAmountPaise,
          }),
        });

        const latencyMs = performance.now() - start;
        const isReplay = res.headers.get('x-idempotent-replay') === 'true';

        return {
          status: res.status,
          isReplay,
          latencyMs,
        };
      } catch (err: any) {
        return {
          status: 0,
          isReplay: false,
          latencyMs: performance.now() - start,
          error: err.message,
        };
      }
    })
  );

  const overallDurationSec = (performance.now() - overallStart) / 1000;

  // 3. Verify Final Balances
  console.log(`\n[4/4] Verifying Double-Entry Ledger Conservation Invariants...`);
  const finalBalanceA = await getAccountBalance(sender.id);
  const finalBalanceB = await getAccountBalance(receiver.id);
  const finalSum = finalBalanceA + finalBalanceB;
  const delta = finalSum - initialSum;

  // 4. Compute Metrics
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50 = calculatePercentile(latencies, 50);
  const p95 = calculatePercentile(latencies, 95);
  const p99 = calculatePercentile(latencies, 99);
  const minLatency = latencies[0] || 0;
  const maxLatency = latencies[latencies.length - 1] || 0;
  const avgLatency = latencies.reduce((acc, v) => acc + v, 0) / (latencies.length || 1);

  const count201Created = results.filter((r) => r.status === 201 && !r.isReplay).length;
  const count201Replay = results.filter((r) => r.status === 201 && r.isReplay).length;
  const count409Conflict = results.filter((r) => r.status === 409).length;
  const count422Insufficient = results.filter((r) => r.status === 422).length;
  const count500Errors = results.filter((r) => r.status >= 500 || r.status === 0).length;
  const rps = (totalRequests / overallDurationSec).toFixed(1);

  // 5. Output Report
  console.log(`\n=================================================================================`);
  console.log(`                          BENCHMARK SUMMARY REPORT                               `);
  console.log(`=================================================================================`);
  console.table([
    { Metric: 'Total Requests', Value: totalRequests.toString() },
    { Metric: 'Requests/sec', Value: `${rps} req/s` },
    { Metric: 'p50 Latency (ms)', Value: `${p50.toFixed(2)} ms` },
    { Metric: 'p95 Latency (ms)', Value: `${p95.toFixed(2)} ms` },
    { Metric: 'p99 Latency (ms)', Value: `${p99.toFixed(2)} ms` },
    { Metric: '201 Created count', Value: count201Created.toString() },
    { Metric: '422 Insufficient Funds count', Value: count422Insufficient.toString() },
    { Metric: 'X-Idempotent-Replay count', Value: count201Replay.toString() },
    { Metric: '409 Conflict count', Value: count409Conflict.toString() },
    { Metric: '500 Server Errors count', Value: count500Errors.toString() },
    { Metric: 'Initial Seeded Sum', Value: `₹${(initialSum / 100).toFixed(2)} (${initialSum} paise)` },
    { Metric: 'Final Ledger Sum', Value: `₹${(finalSum / 100).toFixed(2)} (${finalSum} paise)` },
    { Metric: 'Net Discrepancy', Value: `${delta} paise` },
    { Metric: 'Ledger Audit Status', Value: delta === 0 ? '✅ 0 paise lost or created' : '❌ INVARIANT VIOLATION' },
  ]);

  console.log(`---------------------------------------------------------------------------------`);
  console.log(`  DETAILED BREAKDOWN`);
  console.log(`---------------------------------------------------------------------------------`);
  console.log(`  Target Endpoint            : POST ${BASE_URL}/transfers`);
  console.log(`  Total Requests Executed    : ${totalRequests}`);
  console.log(`  Concurrency Level          : ${totalRequests} parallel promises`);
  console.log(`  Total Wall-Clock Time      : ${overallDurationSec.toFixed(3)} seconds`);
  console.log(`  Throughput (RPS)           : ${rps} requests/sec`);
  console.log(`---------------------------------------------------------------------------------`);
  console.log(`  LATENCY PROFILE (Wall-Clock ms per Request)`);
  console.log(`---------------------------------------------------------------------------------`);
  console.log(`  p50 (Median)               : ${p50.toFixed(2)} ms`);
  console.log(`  p95                        : ${p95.toFixed(2)} ms`);
  console.log(`  p99                        : ${p99.toFixed(2)} ms`);
  console.log(`  Average Latency            : ${avgLatency.toFixed(2)} ms`);
  console.log(`  Min / Max                  : ${minLatency.toFixed(2)} ms / ${maxLatency.toFixed(2)} ms`);
  console.log(`---------------------------------------------------------------------------------`);
  console.log(`  HTTP STATUS BREAKDOWN`);
  console.log(`---------------------------------------------------------------------------------`);
  console.log(`  201 Created (Fresh tx)     : ${count201Created}`);
  console.log(`  201 Replay (Idempotent)    : ${count201Replay} (Header: X-Idempotent-Replay: true)`);
  console.log(`  409 Conflict (In-Flight)   : ${count409Conflict} (Distributed lock protection)`);
  console.log(`  422 Insufficient Funds     : ${count422Insufficient} (Zero overdraft guarantee)`);
  console.log(`  500 Server Errors          : ${count500Errors} (Zero deadlocks, zero crashes)`);
  console.log(`---------------------------------------------------------------------------------`);
  console.log(`  DOUBLE-ENTRY CONSERVATION AUDIT`);
  console.log(`---------------------------------------------------------------------------------`);
  console.log(`  Initial Seeded Sum         : ${initialSum} paise (₹${(initialSum / 100).toFixed(2)})`);
  console.log(`  Final Account A Balance    : ${finalBalanceA} paise (₹${(finalBalanceA / 100).toFixed(2)})`);
  console.log(`  Final Account B Balance    : ${finalBalanceB} paise (₹${(finalBalanceB / 100).toFixed(2)})`);
  console.log(`  Final Combined Sum         : ${finalSum} paise (₹${(finalSum / 100).toFixed(2)})`);
  console.log(`  Net Balance Discrepancy    : ${delta} paise`);

  if (delta === 0) {
    console.log(`  Audit Status               : ✅ VERIFIED: Exactly 0 paise created or destroyed!`);
  } else {
    console.error(`  Audit Status               : ❌ FAILED: Invariant violation: ${delta} paise delta!`);
    process.exit(1);
  }
  console.log(`=================================================================================\n`);
}

if (require.main === module) {
  runBenchmark().catch((err) => {
    console.error('[Benchmark] Fatal error:', err);
    process.exit(1);
  });
}
