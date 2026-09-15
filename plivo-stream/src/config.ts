import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return parsed;
}

export const config = {
  port: optionalInt('PORT', 8000),

  /** Public hostname Plivo can reach, e.g. an ngrok host. No scheme. */
  publicHost: process.env.PUBLIC_HOST,

  /**
   * Plivo auth token. When set, the SDK validates Plivo's V3 signature on every
   * incoming WebSocket, so a stranger who guesses the URL cannot open a stream.
   * Leave unset only for local experiments.
   */
  plivoAuthToken: process.env.PLIVO_AUTH_TOKEN,

  livekit: {
    url: required('LIVEKIT_URL'),
    apiKey: required('LIVEKIT_API_KEY'),
    apiSecret: required('LIVEKIT_API_SECRET'),
  },

  /**
   * Telephony is 8 kHz. Both the Plivo leg and the LiveKit track run at this
   * rate; the agent's plugins resample internally as needed.
   */
  sampleRate: optionalInt('TELEPHONY_SAMPLE_RATE', 8000),

  /** Greeting spoken by Plivo before the stream opens. Empty string disables it. */
  greeting: process.env.GREETING ?? '',
} as const;
