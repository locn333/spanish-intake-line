/**
 * Plivo tells us who is calling in the answer webhook, but the media WebSocket
 * that opens a moment later only carries a call id. This holds the gap.
 *
 * Entries are short-lived by design: the socket normally opens within a second
 * or two of the webhook, so anything still here after the TTL belongs to a call
 * that never connected and would otherwise leak.
 */

export interface CallerInfo {
  /** Caller's number in E.164, as Plivo reported it. */
  from: string;
  /** The number they dialled. */
  to: string;
  receivedAt: number;
}

const TTL_MS = 5 * 60 * 1000;

const pending = new Map<string, CallerInfo>();

/**
 * Repair a phone number that came through form-encoded.
 *
 * Plivo sends `From=+17143638910` with a literal `+`, but in
 * `application/x-www-form-urlencoded` a `+` *means a space*, so a correct body
 * parser hands us " 17143638910". Left alone that becomes a callback number
 * with a leading space and no country-code marker.
 */
export function normalizePhone(raw: string | undefined): string {
  const value = (raw ?? '').replace(/\s+/g, '');
  if (!value) return '';
  if (value.startsWith('+')) return value;
  // Only add the marker back when what remains really is a bare number;
  // anything else (a SIP URI, an alphanumeric sender id) is passed through.
  return /^\d{7,}$/.test(value) ? `+${value}` : value;
}

export function rememberCaller(callId: string, info: Omit<CallerInfo, 'receivedAt'>): void {
  sweep();
  pending.set(callId, {
    from: normalizePhone(info.from),
    to: normalizePhone(info.to),
    receivedAt: Date.now(),
  });
}

/**
 * Read and remove the caller info for a call. Returns undefined when the answer
 * webhook never fired for this id — for example on an outbound call, where the
 * stream exists but no inbound webhook preceded it.
 */
export function takeCaller(callId: string): CallerInfo | undefined {
  const info = pending.get(callId);
  if (info) pending.delete(callId);
  return info;
}

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [callId, info] of pending) {
    if (info.receivedAt < cutoff) pending.delete(callId);
  }
}

/** Exposed for the health endpoint. */
export function pendingCount(): number {
  return pending.size;
}
