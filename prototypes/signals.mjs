// Not a server trust boundary: all browser observations can be forged by a game.
export function evaluatePlay(samples, { mode, maxGapMs }) {
  if (!['continuous', 'cumulative'].includes(mode) || !Number.isFinite(maxGapMs) || maxGapMs <= 0) {
    throw new TypeError('Explicit T-16 mode and experimental heartbeat gap required');
  }
  let elapsed = 0, interaction = false, previous;
  for (const sample of samples) {
    if (!Number.isFinite(sample.at) || sample.at < 0 || (previous && sample.at <= previous.at)) {
      return { candidate: false, reason: 'invalid-sequence', elapsed: 0 };
    }
    const active = s => s.loaded === true && s.visible === true && s.healthy === true && s.online === true;
    const gap = previous ? sample.at - previous.at : 0;
    if (active(sample) && previous && active(previous) && gap <= maxGapMs) elapsed += gap;
    else if (mode === 'continuous') elapsed = 0;
    if (active(sample) && sample.interaction === true) interaction = true;
    previous = sample;
  }
  const healthy = previous?.loaded && previous?.visible && previous?.healthy && previous?.online;
  return { candidate: Boolean(healthy && elapsed >= 10000 && interaction), elapsed, reason: 'untrusted-client-candidate' };
}
export function acceptMessage(event, context, now) {
  const d = event.data;
  if (event.origin !== context.origin || event.source !== context.source || !d || typeof d !== 'object' || Array.isArray(d)) return false;
  if (Object.keys(d).sort().join(',') !== 'seq,session,type,v' || d.v !== 1 || d.session !== context.session ||
      !['ready', 'heartbeat', 'interaction', 'error'].includes(d.type) || !Number.isSafeInteger(d.seq) || d.seq <= context.seq) return false;
  if (!Number.isFinite(now) || now < context.lastAt || now - context.lastAt < context.minIntervalMs) return false;
  context.seq = d.seq;
  context.lastAt = now;
  return true;
}
