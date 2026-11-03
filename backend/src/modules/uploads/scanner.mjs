import { createConnection } from 'node:net';
import { once } from 'node:events';

// Clamd INSTREAM: https://docs.clamav.net/manual/Usage/ClamdProtocol.html
export function createScanner({ host = '127.0.0.1', port = 3310, timeout = 30000 } = {}) {
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Local scanner must use loopback');
  return async bytes => {
    const socket = createConnection({ host, port });
    let reply = '', timer;
    const response = new Promise((resolve, reject) => {
      timer = setTimeout(() => { socket.destroy(new Error('Scan timeout')); reject(new Error('Scan timeout')); }, timeout);
      socket.on('error', reject);
      socket.on('data', data => {
        reply += data.toString('utf8');
        if (reply.length > 4096) { socket.destroy(); reject(new Error('Invalid scan response')); }
        if (reply.includes('\0')) resolve(reply.slice(0, reply.indexOf('\0')));
      });
      socket.on('end', () => { if (!reply.includes('\0')) reject(new Error('Truncated scan response')); });
    });
    // Attach the rejection handler before connection/write awaits.
    response.catch(() => {});
    try {
      await once(socket, 'connect');
      const write = async data => { if (!socket.write(data)) await once(socket, 'drain'); };
      await write(Buffer.from('zINSTREAM\0'));
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const chunk = bytes.subarray(offset, offset + 65536), size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length); await write(size); await write(chunk);
      }
      await write(Buffer.alloc(4));
      const result = await response;
      return { status: result === 'stream: OK' ? 'clean' : /^stream: .+ FOUND$/.test(result) ? 'infected' : 'error', engine: 'clamd' };
    } catch { return { status: 'error', engine: 'clamd' }; }
    finally { clearTimeout(timer); socket.destroy(); }
  };
}
