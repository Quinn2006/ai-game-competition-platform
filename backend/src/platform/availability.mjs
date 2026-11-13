import { readFile } from 'node:fs/promises';

// This file is writable only by the controller; the application identity can
// read it. A stale lease cannot survive a suspended or crashed controller.
export function createAvailability(file, clock = Date.now) {
  let draining = false;
  return {
    drain() { draining = true; },
    async state() {
      if (draining) return 'draining';
      if (!file) return 'open'; // Development and explicit injected tests only.
      try {
        const lease = JSON.parse(await readFile(file, 'utf8')), now = clock();
        if (lease.version !== 1) return 'closed';
        if (lease.state === 'draining') return 'draining';
        return lease.state === 'open' && Number.isSafeInteger(lease.issuedAt) && Number.isSafeInteger(lease.expiresAt)
          && lease.issuedAt <= now && now < lease.expiresAt && lease.expiresAt - lease.issuedAt <= 15000 ? 'open' : 'closed';
      } catch { return 'closed'; }
    },
    async permits() { return await this.state() === 'open'; },
  };
}
