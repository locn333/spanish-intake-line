import type { WebSocket } from 'ws';

import express from 'express';
import PlivoWebSocketServer from 'plivo-stream-sdk-node';
import type { DTMFEvent, MediaEvent, StartEvent } from 'plivo-stream-sdk-node';

import { CallBridge } from './call-bridge.js';
import { normalizePhone, pendingCount, rememberCaller, takeCaller } from './call-registry.js';
import { config } from './config.js';

const app = express();
app.use(express.urlencoded({ extended: false }));

/** One bridge per open phone call, keyed by the Plivo WebSocket. */
const bridges = new Map<WebSocket, CallBridge>();

/**
 * Plivo's answer URL. Plivo POSTs here by default; GET is accepted too so the
 * endpoint can be opened in a browser to eyeball the XML.
 */
app.all('/answer', (req, res) => {
  const host = config.publicHost ?? req.get('host');
  if (!host) {
    res.status(500).send('Cannot determine public host; set PUBLIC_HOST.');
    return;
  }

  // Plivo sends these as form fields on POST and query params on GET. This is
  // the only place the caller's number is available — the media socket that
  // follows carries just a call id.
  const params = { ...req.query, ...req.body } as Record<string, string | undefined>;
  const callId = params.CallUUID;
  if (callId) {
    rememberCaller(callId, { from: params.From ?? '', to: params.To ?? '' });
    console.log(`[${callId}] inbound from ${normalizePhone(params.From) || 'unknown'}`);
  }

  const streamUrl = `wss://${host}/stream`;
  const greeting = config.greeting
    ? `<Speak>${escapeXml(config.greeting)}</Speak>`
    : '';

  // bidirectional: we send audio back down the same socket.
  // keepCallAlive: the call stays up after <Stream> instead of hanging up.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${greeting}
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=${config.sampleRate}">${streamUrl}</Stream>
</Response>`;

  res.type('application/xml').send(xml);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, activeCalls: bridges.size, pendingAnswers: pendingCount() });
});

const server = app.listen(config.port, () => {
  console.log(`HTTP listening on :${config.port}`);
  console.log(`Answer URL path: /answer   WebSocket path: /stream`);
});

if (!config.plivoAuthToken) {
  console.warn(
    'PLIVO_AUTH_TOKEN is unset: incoming stream signatures will NOT be verified. ' +
      'Set it before exposing this server publicly.',
  );
}

const plivo = new PlivoWebSocketServer({
  server,
  path: '/stream',
  validateSignature: Boolean(config.plivoAuthToken),
  authToken: config.plivoAuthToken,
});

plivo
  .onStart(async (event: StartEvent, ws: WebSocket) => {
    const { callId, streamId, mediaFormat } = event.start;
    console.log(
      `[${callId}] stream ${streamId} started (${mediaFormat.encoding} @ ${mediaFormat.sampleRate}Hz)`,
    );

    const caller = takeCaller(callId);

    const bridge = new CallBridge({
      callId,
      encoding: mediaFormat.encoding,
      sampleRate: mediaFormat.sampleRate,
      callerNumber: caller?.from || undefined,
      dialedNumber: caller?.to || undefined,
      onAudio: (payload) => {
        if (plivo.isActive(ws)) {
          plivo.playAudio(ws, 'audio/x-mulaw', mediaFormat.sampleRate, payload);
        }
      },
      onClearAudio: () => {
        if (plivo.isActive(ws)) plivo.clearAudio(ws);
      },
    });

    // Register before connecting so a hangup mid-connect still finds the bridge
    // and closes it.
    bridges.set(ws, bridge);

    try {
      await bridge.connect();
      console.log(`[${callId}] joined LiveKit room ${bridge.roomName}`);
    } catch (err) {
      console.error(`[${callId}] failed to join LiveKit:`, err);
      bridges.delete(ws);
      await bridge.close();
      ws.close();
    }
  })
  .onMedia((event: MediaEvent, ws: WebSocket) => {
    bridges.get(ws)?.pushCallerAudio(event.getRawMedia());
  })
  .onDtmf((event: DTMFEvent, ws: WebSocket) => {
    const bridge = bridges.get(ws);
    if (!bridge) return;

    console.log(`DTMF ${event.dtmf.digit}`);
    // '*' is a manual barge-in escape hatch for callers stuck under a long
    // answer; the agent-state watcher handles ordinary interruptions.
    if (event.dtmf.digit === '*') plivo.clearAudio(ws);
    bridge.sendDtmf(event.dtmf.digit);
  })
  .onError((error: Error, ws: WebSocket) => {
    console.error(`Plivo stream error:`, error.message);
    void teardown(ws);
  })
  .onClose((ws: WebSocket) => {
    console.log('Plivo socket closed');
    void teardown(ws);
  })
  .start();

async function teardown(ws: WebSocket): Promise<void> {
  const bridge = bridges.get(ws);
  if (!bridge) return;
  bridges.delete(ws);
  await bridge.close();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, closing ${bridges.size} call(s)...`);
    void Promise.all([...bridges.keys()].map(teardown)).finally(() => {
      server.close(() => process.exit(0));
    });
  });
}
