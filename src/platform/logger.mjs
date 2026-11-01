// Allowlisted fields only. No raw exceptions, URLs, headers, bodies, IP or UA.
const fields = new Set(['requestId', 'method', 'route', 'status', 'durationMs', 'code', 'environment']);
const events = new Set(['http.request', 'app.started', 'app.stopped', 'app.failed', 'database.error', 'migration.finished']);
export function createLogger(write = line => process.stdout.write(line)) {
  return (event, data = {}) => {
    if (!events.has(event)) throw new Error('Unknown log event');
    const record = { time: new Date().toISOString(), event };
    for (const [key, value] of Object.entries(data)) {
      if (fields.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) record[key] = value;
    }
    write(`${JSON.stringify(record)}\n`);
  };
}
