// Bound readiness latency even when a dependency driver never settles.
// Drivers still need their own cancellation/connection limits.
export async function dependenciesReady(checks, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([
      Promise.allSettled(checks.map(check => Promise.resolve().then(check)))
        .then(results => results.every(result => result.status === 'fulfilled' && result.value === true)),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Notify once per transition; retry a failed delivery on the next observation.
export function createHealthMonitor({ notify, failures = 3, recoveries = 2 }) {
  if (typeof notify !== 'function' || ![failures, recoveries].every(n => Number.isInteger(n) && n > 0)) throw new Error('Invalid monitor settings');
  let state = 'healthy', bad = 0, good = 0;
  return async healthy => {
    if (typeof healthy !== 'boolean') throw new Error('Invalid health observation');
    bad = healthy ? 0 : bad + 1;
    good = healthy ? good + 1 : 0;
    const next = state === 'healthy' && bad >= failures ? 'unhealthy'
      : state === 'unhealthy' && good >= recoveries ? 'healthy' : state;
    if (next !== state) {
      await notify({ event: next === 'healthy' ? 'service.recovered' : 'service.unavailable' });
      state = next;
    }
    return state;
  };
}
