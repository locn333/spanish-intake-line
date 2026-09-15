# Spanish phone intake line

A Spanish-speaking customer calls your Plivo number. A voice agent answers in
Spanish, asks who they are and what they need, and emails you the message with
an English translation.

Under the hood the call's audio is streamed over a WebSocket into a LiveKit room
where a [LiveKit Agent](https://docs.livekit.io/reference/agents-js/) answers it.
Two processes:

| Process | What it is | Run with |
| --- | --- | --- |
| **Bridge** (repo root) | Express answer URL + Plivo WebSocket server. Translates between the phone leg and a LiveKit room. | `npm run dev` |
| **Agent** (`agent/`) | Spanish intake agent. Speko routes STT/LLM/TTS per call. Never talks to Plivo. | `cd agent && npm run dev` |

## Why this exists: inbound without SIP

Inbound on a Plivo number can be routed two ways, and the difference is the
whole point of this repo:

- **SIP trunk** — Plivo forwards the call to a SIP URI. If nothing is listening
  at that URI you get `Destination Not Found` (a 404) and the caller hears a
  failure tone. Reaching a hosted agent platform this way requires that
  platform's inbound SIP URI.
- **Application + Answer URL** — Plivo fetches XML from your server on each
  inbound call and does what it says. No trunk, no SIP URI, nothing to look up.

This bridge takes the second path, which is why inbound works here without
resolving a forwarding target. Assign the number to a Plivo **Application**
whose Answer URL is `https://<your host>/answer`, not to a SIP trunk.

The split matters: the bridge is stateless plumbing you rarely touch, while the
agent is where the product lives. The agent has no idea the caller is on a
phone — swap Plivo for SIP or a browser and the agent is unchanged.

## Audio path

```
caller ─PSTN→ Plivo ─WS(mu-law 8k)→ bridge ─PCM16 8k→ LiveKit room ─→ agent ─→ Speko router ─→ STT/LLM/TTS
caller ←PSTN─ Plivo ←WS(mu-law 8k)─ bridge ←PCM16 8k← LiveKit room ←─ agent ←─────────────────────┘
```

Two conversions happen, both in the bridge:

- **mu-law ↔ PCM16** — `src/mulaw.ts`, a port of Sun's reference G.711. Plivo
  speaks `audio/x-mulaw`; LiveKit wants Int16 samples.
- **Sample rate** — handled for free. `AudioStream` is constructed with
  `sampleRate: 8000`, so LiveKit resamples the agent's 24 kHz TTS output down to
  telephony rate before the bridge ever sees it.

## Barge-in

When a caller interrupts, the agent stops generating immediately — but Plivo is
still holding every audio chunk already sent, so without intervention the caller
hears the tail of an abandoned sentence.

The bridge watches the agent's `lk.agent.state` participant attribute. On any
transition *out of* `speaking`, it sends Plivo a `clearAudio`, dropping the
queue. Pressing `*` does the same thing manually.

## Setup

```bash
cp .env.example .env                 # fill in LiveKit + Plivo credentials
npm install

cp agent/.env.example agent/.env     # same LiveKit project, plus a Speko API key
cd agent && npm install && cd ..
```

`agent/` installs `onnxruntime-node` for Silero VAD, which downloads a native
binary on install. If your network blocks that, `npm install --ignore-scripts`
gets you type-checkable code but the VAD will not load at runtime.

Run both, plus a tunnel:

```bash
npm run dev                 # terminal 1 — bridge on :8000
cd agent && npm run dev     # terminal 2 — agent worker
ngrok http 8000             # terminal 3
```

Then, in the Plivo console:

1. Create an **Application** with Answer URL `https://<ngrok host>/answer`
   (method POST).
2. Open the number and assign it to that Application. If it is currently routed
   to a SIP trunk, this replaces that routing — which is what makes inbound stop
   404ing.
3. Set `PUBLIC_HOST` to the ngrok host (no scheme) and restart the bridge.

Call the number.

## What the agent does

It takes a message in Spanish and nothing else. It greets the caller, asks for
their name, a callback number, and what they need — one question at a time —
reads the whole thing back, and only then records it. It does not quote prices,
promise dates, or try to solve anything; if pushed, it says someone will call
back.

The recorded message carries the request twice: in the caller's own Spanish, and
in English. The English version is produced by the model during the call rather
than by a translation pass afterwards, because it has the whole conversation as
context — a standalone translator sees one sentence with no idea what was being
discussed.

If the caller says the callback number is the one they are calling from, or the
number comes through garbled, the record falls back to Plivo's caller ID.
Storing a wrong callback number is worse than storing none.

## How messages reach you

Set `SMTP_URL` and `OWNER_EMAIL` and you are done — email needs no carrier
registration and works the day you set it up. Each message arrives with the
caller's name, callback number, the English translation, and their original
Spanish.

Two SMS channels exist and both stay off until configured:

- **A short alert to your own phone** (`OWNER_SMS_NUMBER`) alongside the email.
- **A Spanish confirmation to the customer**, gated behind `SMS_10DLC_READY`.

That gate is not caution for its own sake. Texting US numbers from an
application requires A2P 10DLC registration with the carriers; until the
campaign is approved, messages are filtered or dropped *and the API still
reports success*. Leaving the flag false keeps that failure visible as a skip
rather than invisible as a lie.

Each channel fails on its own: a broken SMTP config cannot cost you the SMS, and
a blocked SMS cannot cost you the email.

## Layout

```
src/
  config.ts         env parsing, fails fast on missing credentials
  mulaw.ts          G.711 mu-law <-> PCM16
  mulaw.test.ts     codec tests
  call-registry.ts  holds caller ID between the webhook and the media socket
  call-bridge.ts    one LiveKit room per call; both audio directions
  server.ts         answer URL + Plivo socket handlers
agent/src/
  agent.ts          the Spanish intake agent
  intake.ts         message shape + phone-number normalization
  intake.test.ts    normalization tests
  delivery.ts       email and SMS fan-out
```

## Notes

- **Set `PLIVO_AUTH_TOKEN`.** The SDK then verifies Plivo's V3 signature on every
  incoming socket. Without it, anyone who learns the URL can open a stream. The
  server warns at boot when it is unset.
- **No provider keys in `agent/`.** Speko picks STT/LLM/TTS per call and handles
  failover server-side; `SPEKO_API_KEY` is the only model credential.
- **`optimizeFor: 'cost'`** pins the cheapest tier. Change it in `agent.ts` to
  `'latency'` if turn latency grates — that is the knob, not the model names.
- **`SPEKO_AGENT_ID` is optional** and only loads tools registered against that
  Speko agent. It does not make the hosted agent answer; this worker runs the
  prompt in `agent.ts`.
- **Silero loads in `prewarm`**, once per worker process. Loading it per call
  would be dead air on the line.
- **Caller ID arrives on the webhook, not the socket.** Plivo sends `From` to
  `/answer`; the media socket that follows carries only a call id. The bridge
  holds them together in `call-registry.ts` and stamps the number onto the
  LiveKit participant so the agent can read it.
- One room per call, named `plivo-<callId>`.
