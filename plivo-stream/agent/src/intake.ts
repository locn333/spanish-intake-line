/**
 * The shape of one captured message. The agent fills this in during the call;
 * delivery reads it afterwards.
 */
export interface Intake {
  /** Caller's name as they said it. */
  name: string;
  /**
   * Callback number in E.164. Defaults to the caller ID Plivo reported, but the
   * agent overrides it when the caller gives a different one — people often
   * call from a work phone and want the callback elsewhere.
   */
  callbackNumber: string;
  /** What they need, in their own words. */
  requestSpanish: string;
  /**
   * The same request in English. Produced by the model during the call rather
   * than by a separate translation pass afterwards: it already has the full
   * conversation as context, which a standalone translator would not.
   */
  requestEnglish: string;
  /** Whether the agent read the details back and the caller agreed. */
  confirmed: boolean;
}

export interface CallRecord extends Intake {
  callId: string;
  /** Caller ID from Plivo, which may differ from callbackNumber. */
  callerNumber: string;
  dialedNumber: string;
  startedAt: string;
  endedAt: string;
  /**
   * Full conversation transcript, independent of whether the intake tool ever
   * fired — a caller who hangs up mid-call still leaves a record of what was
   * said. Empty when the call produced no transcribable speech.
   */
  transcriptSpanish: string;
  /** Same transcript translated to English, or empty if translation failed. */
  transcriptEnglish: string;
}

export function isComplete(intake: Partial<Intake>): intake is Intake {
  return Boolean(
    intake.name?.trim() &&
      intake.callbackNumber?.trim() &&
      intake.requestSpanish?.trim() &&
      intake.requestEnglish?.trim(),
  );
}

/**
 * Normalise a spoken number to E.164, assuming US when no country code is
 * given. Returns undefined when it does not look like a phone number at all,
 * so the caller ID is kept instead of a garbled override.
 */
export function toE164(spoken: string, defaultCountry = '1'): string | undefined {
  const digits = spoken.replace(/\D/g, '');
  if (digits.length < 7) return undefined;

  if (spoken.trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length === 11 && digits.startsWith(defaultCountry)) return `+${digits}`;
  return `+${digits}`;
}
