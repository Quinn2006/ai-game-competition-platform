import { AppError } from '../../platform/errors.mjs';
export const dayOf = now => new Date(now+8*3600000).toISOString().slice(0,10);
// Only adjacent, timely foreground samples contribute. Background gaps and stalled
// event loops cannot be backfilled by a client-supplied duration.
export function advance(session,input,now) {
  if(!Number.isSafeInteger(input.sequence)||input.sequence!==session.sequence+1 ||
    !['tick','end','error'].includes(input.kind)||typeof input.foreground!=='boolean'||
    typeof input.interacted!=='boolean'||typeof input.healthy!=='boolean') throw new AppError('INVALID_SIGNAL',409,'试玩信号无效');
  const gap=now-Number(new Date(session.updated_at));
  const failed=session.failed||input.kind==='error'||!input.healthy;
  const elapsed=session.elapsed_ms+(!failed&&gap>0&&gap<=5000&&session.foreground&&input.foreground?gap:0);
  const interacted=session.interacted||(input.interacted&&input.foreground&&input.healthy);
  return {elapsed,interacted,failed,valid:!failed&&elapsed>=10000&&interacted,anomaly:gap>5000};
}
