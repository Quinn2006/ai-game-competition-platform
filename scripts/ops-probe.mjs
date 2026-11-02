import { createHealthMonitor } from '../src/platform/health.mjs';
import { pathToFileURL } from 'node:url';

export function localTarget(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Only explicit loopback HTTP targets are allowed');
  return url;
}

export async function probe(url, timeoutMs = 3000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (response.body) {
      const reader = response.body.getReader();
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) { await reader.cancel(); return false; }
      }
    }
    return response.status === 200;
  } catch { return false; }
}

export async function loadProbe(url, { requests = 200, concurrency = 10, timeoutMs = 3000 } = {}) {
  localTarget(String(url));
  if (!Number.isInteger(requests) || requests < 1 || requests > 10000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('Invalid bounded load settings');
  let next = 0, errors = 0;
  const durations = [], start = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
    while (next++ < requests) {
      const began = performance.now();
      if (!await probe(url, timeoutMs)) errors++;
      durations.push(performance.now() - began);
    }
  }));
  durations.sort((a,b) => a-b);
  const elapsedMs = performance.now() - start;
  return { requests, concurrency, errors, errorRate: errors / requests,
    p50Ms: durations[Math.ceil(requests * .5)-1], p95Ms: durations[Math.ceil(requests * .95)-1],
    p99Ms: durations[Math.ceil(requests * .99)-1], elapsedMs, requestsPerSecond: requests * 1000 / elapsedMs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, target] = process.argv.slice(2);
    const url = localTarget(target);
    if (mode === 'load') {
      const report = await loadProbe(url);
      console.log(JSON.stringify(report));
      if (report.errors) process.exitCode = 1;
    } else if (mode === 'monitor') {
      const observe = createHealthMonitor({ notify: async event => console.log(JSON.stringify({ time: new Date().toISOString(), ...event })) });
      let stopped = false;
      process.on('SIGINT', () => { stopped = true; });
      process.on('SIGTERM', () => { stopped = true; });
      while (!stopped) {
        await observe(await probe(url));
        if (!stopped) await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } else throw new Error('Unknown mode');
  } catch { console.error('OPS_PROBE_FAILED: use load|monitor and an explicit loopback HTTP URL'); process.exitCode = 1; }
}
