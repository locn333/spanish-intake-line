import nodemailer from 'nodemailer';
import plivo from 'plivo';

import type { CallRecord } from './intake.js';

/**
 * Sending SMS to a US number from an application requires A2P 10DLC
 * registration with the carriers. Unregistered traffic is filtered or dropped,
 * and it fails quietly — the API returns success and the message never lands.
 *
 * So customer-facing SMS stays off until SMS_10DLC_READY is explicitly set.
 * Email and the owner alert do not depend on it.
 */
const TEN_DLC_READY = process.env.SMS_10DLC_READY === 'true';

const PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID;
const PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN;
const PLIVO_SMS_FROM = process.env.PLIVO_SMS_FROM;

const OWNER_SMS = process.env.OWNER_SMS_NUMBER;
const OWNER_EMAIL = process.env.OWNER_EMAIL;

const SMTP_URL = process.env.SMTP_URL;
const MAIL_FROM = process.env.MAIL_FROM ?? 'voicemail@localhost';

export interface DeliveryOutcome {
  email: 'sent' | 'skipped' | 'failed';
  ownerSms: 'sent' | 'skipped' | 'failed';
  callerSms: 'sent' | 'skipped-10dlc' | 'skipped' | 'failed';
  errors: string[];
}

/**
 * Fan the captured message out to every configured channel. Each channel fails
 * independently: a broken SMTP config must not cost you the SMS alert, and a
 * blocked SMS must not cost you the email.
 */
export async function deliver(record: CallRecord): Promise<DeliveryOutcome> {
  const outcome: DeliveryOutcome = {
    email: 'skipped',
    ownerSms: 'skipped',
    callerSms: 'skipped',
    errors: [],
  };

  const results = await Promise.allSettled([
    sendEmail(record),
    sendOwnerSms(record),
    sendCallerConfirmation(record),
  ]);

  const [email, ownerSms, callerSms] = results;

  if (email?.status === 'fulfilled') outcome.email = email.value;
  else if (email?.status === 'rejected') {
    outcome.email = 'failed';
    outcome.errors.push(`email: ${errText(email.reason)}`);
  }

  if (ownerSms?.status === 'fulfilled') outcome.ownerSms = ownerSms.value;
  else if (ownerSms?.status === 'rejected') {
    outcome.ownerSms = 'failed';
    outcome.errors.push(`ownerSms: ${errText(ownerSms.reason)}`);
  }

  if (callerSms?.status === 'fulfilled') outcome.callerSms = callerSms.value;
  else if (callerSms?.status === 'rejected') {
    outcome.callerSms = 'failed';
    outcome.errors.push(`callerSms: ${errText(callerSms.reason)}`);
  }

  return outcome;
}

async function sendEmail(record: CallRecord): Promise<'sent' | 'skipped'> {
  if (!SMTP_URL || !OWNER_EMAIL) return 'skipped';

  // A caller who hangs up before finishing the three-question intake still
  // leaves a transcript — that is more useful to the owner than nothing, so
  // the subject and summary lines degrade gracefully when name/request are
  // blank rather than being skipped outright.
  const hasIntake = Boolean(record.name || record.requestEnglish);
  const subject = hasIntake
    ? `New Spanish message from ${record.name} (${record.callbackNumber})`
    : `Spanish call transcript — no message captured (${record.callerNumber || 'unknown caller'})`;

  const transport = nodemailer.createTransport(SMTP_URL);
  await transport.sendMail({
    from: MAIL_FROM,
    to: OWNER_EMAIL,
    subject,
    text: [
      hasIntake ? `Name:     ${record.name}` : '',
      hasIntake ? `Call back: ${record.callbackNumber}` : '',
      `Caller ID: ${record.callerNumber || 'withheld'}`,
      `Received:  ${record.endedAt}`,
      hasIntake && !record.confirmed ? 'NOTE: caller did not confirm these details.' : '',
      hasIntake ? '' : 'NOTE: call ended before a message was captured. See transcript below.',
      '',
      ...(hasIntake
        ? ['--- What they need (English) ---', record.requestEnglish, '', '--- Their words (Spanish) ---', record.requestSpanish, '']
        : []),
      ...(record.transcriptEnglish
        ? ['--- Full call transcript (English translation) ---', record.transcriptEnglish, '']
        : []),
      ...(record.transcriptSpanish
        ? ['--- Full call transcript (original Spanish) ---', record.transcriptSpanish, '']
        : []),
      `Call id: ${record.callId}`,
    ]
      .filter((line) => line !== '')
      .join('\n'),
  });

  return 'sent';
}

async function sendOwnerSms(record: CallRecord): Promise<'sent' | 'skipped'> {
  // No name/request means the caller hung up before the intake tool ever
  // fired — the transcript email covers that case; a text alert with nothing
  // in it would just be noise.
  if (!OWNER_SMS || !record.name) return 'skipped';

  // Keep it inside one segment where possible; the full text is in the email.
  const body = truncate(
    `New call: ${record.name} ${record.callbackNumber} — ${record.requestEnglish}`,
    300,
  );
  await sendSms(OWNER_SMS, body);
  return 'sent';
}

async function sendCallerConfirmation(
  record: CallRecord,
): Promise<'sent' | 'skipped' | 'skipped-10dlc'> {
  if (!TEN_DLC_READY) return 'skipped-10dlc';
  if (!record.callbackNumber) return 'skipped';

  await sendSms(
    record.callbackNumber,
    truncate(`Gracias por llamar, ${record.name}. Recibimos su mensaje y le responderemos pronto.`, 300),
  );
  return 'sent';
}

/** Send one SMS via Plivo. Throws when Plivo is not configured. */
export async function sendSms(to: string, text: string): Promise<void> {
  if (!PLIVO_AUTH_ID || !PLIVO_AUTH_TOKEN || !PLIVO_SMS_FROM) {
    throw new Error('Plivo SMS is not configured (PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN / PLIVO_SMS_FROM)');
  }

  const client = new plivo.Client(PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN);
  // Positional form: the SDK also accepts a single options object at runtime,
  // but only the positional signature is declared in its types.
  await client.messages.create(PLIVO_SMS_FROM, to, text);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function errText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
