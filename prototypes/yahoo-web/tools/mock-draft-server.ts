/**
 * Minimal WebSocket server that speaks Yahoo's draft-room protocol, for testing the client
 * end to end without touching Yahoo.
 *
 * It exists because the real room does not open until minutes before the draft, and the
 * client's behaviour on our turn — recommend, input window, frame construction — is the one
 * path that cannot otherwise be exercised beforehand.
 *
 * Implements only what the client needs: the RFC 6455 handshake, unmasked text frames out,
 * masked text frames in. No ping/pong, no fragmentation, no binary.
 *
 *   npx tsx tools/mock-draft-server.ts [--port 8787] [--our-pick-secs 30]
 */
import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const PORT = Number(arg('--port') ?? 8787);
const OUR_TEAM = arg('--our-team') ?? '6';
const DRAFT_ID = arg('--draft-id') ?? '48535';
const CLOCK = Number(arg('--our-pick-secs') ?? 30);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeText(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const head: number[] = [0x81];
  if (body.length < 126) head.push(body.length);
  else if (body.length < 65536) head.push(126, body.length >> 8, body.length & 0xff);
  else throw new Error('frame too large for this mock');
  return Buffer.concat([Buffer.from(head), body]);
}

/** Decode one masked client text frame. Returns the payload and bytes consumed. */
function decodeFrame(buf: Buffer): { text: string; used: number } | undefined {
  if (buf.length < 2) return undefined;
  const len0 = buf[1]! & 0x7f;
  const masked = (buf[1]! & 0x80) !== 0;
  let offset = 2;
  let len = len0;
  if (len0 === 126) {
    if (buf.length < 4) return undefined;
    len = buf.readUInt16BE(2);
    offset = 4;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return undefined;
  const mask = buf.subarray(offset, offset + maskLen);
  const data = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
  if (masked) for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i % 4]!;
  return { text: data.toString('utf8'), used: offset + maskLen + len };
}

const server = createServer((sock: Socket) => {
  let handshaken = false;
  let buffer = Buffer.alloc(0);
  const send = (s: string): void => {
    console.log(`  server -> ${s.slice(0, 110)}`);
    sock.write(encodeText(s));
  };

  sock.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    if (!handshaken) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headers = buffer.subarray(0, headerEnd).toString();
      const key = /sec-websocket-key:\s*(.+)/i.exec(headers)?.[1]?.trim();
      if (!key) {
        sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      sock.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      handshaken = true;
      buffer = buffer.subarray(headerEnd + 4);
      console.log('  handshake complete');
    }

    for (;;) {
      const frame = decodeFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.used);
      console.log(`  client -> ${frame.text.slice(0, 110)}`);
      const fields = frame.text.split('|');

      if (fields[0] === '8') {
        // Join. Replay a realistic opening: header, order, presence, board, then our clock.
        send('H|S|90|0|0|1');
        send('R|1|2|3|4|5|6|7|8');
        send('Q');
        send(`A|1=0|2=0|3=0|4=0|5=0|${OUR_TEAM}=1|7=0|8=0`);
        send(`J|${OUR_TEAM}`);
        // Five picks already gone: McDavid, MacKinnon, Kucherov, Celebrini, Draisaitl.
        send('P|1=6743,1,0|2=5980,2,0|3=5425,3,0|4=30139,4,0|5=6369,5,0');
        setTimeout(() => send(`D|6|${OUR_TEAM}|${CLOCK}`), 500);
        continue;
      }

      if (fields[0] === '0' && fields.length === 5) {
        // A submitted pick: acknowledge it the way the real server does.
        const [, , teamId, pick, playerId] = fields;
        send(`0|${pick}|${playerId}|${teamId}|C|0`);
        setTimeout(() => send('D|7|7|90'), 300);
        continue;
      }

      if (fields[0] === '6') {
        send(`6|${fields[2] ?? OUR_TEAM}`);
        continue;
      }
    }
  });

  sock.on('error', () => undefined);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock draft server on ws://127.0.0.1:${PORT}  draft ${DRAFT_ID} team ${OUR_TEAM} clock ${CLOCK}s`);
});
