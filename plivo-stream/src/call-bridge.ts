import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
} from '@livekit/rtc-node';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { AccessToken } from 'livekit-server-sdk';

import { config } from './config.js';
import { decodeBuffer, encodeBuffer, pcm16FromBuffer } from './mulaw.js';

/**
 * LiveKit agents publish their lifecycle on this participant attribute. Values
 * are "initializing" | "idle" | "listening" | "thinking" | "speaking".
 */
const AGENT_STATE_ATTRIBUTE = 'lk.agent.state';

export interface CallBridgeOptions {
  callId: string;
  /** Encoding Plivo reported in the start event, e.g. "audio/x-mulaw". */
  encoding: string;
  sampleRate: number;
  /** Caller's number in E.164, when the answer webhook supplied one. */
  callerNumber?: string;
  /** Number the caller dialled. */
  dialedNumber?: string;
  /** Called when the bridge wants audio sent back down the phone leg. */
  onAudio: (payload: Buffer) => void;
  /** Called when queued phone-leg audio should be dropped (barge-in). */
  onClearAudio: () => void;
}

/**
 * Joins one LiveKit room on behalf of one phone call.
 *
 * Inbound: Plivo media frames -> PCM16 -> a published LiveKit audio track the
 * agent subscribes to. Outbound: the agent's track -> PCM16 at the telephony
 * rate -> mu-law -> back down the Plivo socket.
 */
export class CallBridge {
  readonly roomName: string;

  private readonly room = new Room();
  private readonly opts: CallBridgeOptions;
  private readonly source: AudioSource;
  private readonly isMuLaw: boolean;

  /**
   * captureFrame() is async and self-pacing, so frames are chained rather than
   * awaited inline — Plivo's socket callback must not block, and chaining keeps
   * frames strictly ordered.
   */
  private captureChain: Promise<void> = Promise.resolve();

  private closed = false;
  private agentState = 'unknown';
  private outboundAbort = new AbortController();

  constructor(opts: CallBridgeOptions) {
    this.opts = opts;
    this.roomName = `plivo-${opts.callId}`;
    this.isMuLaw = opts.encoding.includes('mulaw');
    this.source = new AudioSource(opts.sampleRate, 1);
  }

  async connect(): Promise<void> {
    const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: `caller-${this.opts.callId}`,
      name: 'Phone caller',
      // The call ends when the caller hangs up; don't leave empty rooms around.
      ttl: '2h',
      // The agent reads these to know who it is talking to. Attributes rather
      // than metadata so the agent can read one field without parsing JSON.
      attributes: {
        'plivo.callId': this.opts.callId,
        ...(this.opts.callerNumber ? { 'plivo.from': this.opts.callerNumber } : {}),
        ...(this.opts.dialedNumber ? { 'plivo.to': this.opts.dialedNumber } : {}),
      },
    });
    token.addGrant({
      room: this.roomName,
      roomJoin: true,
      // Required for roomConfig (below) to take effect — LiveKit only honors
      // agent-dispatch configuration from the token that creates the room.
      roomCreate: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    // Explicit dispatch: this LiveKit project also has the English demo
    // line's worker registered. Without naming the agent here, LiveKit would
    // hand the room to whichever generic worker was free.
    token.roomConfig = new RoomConfiguration({
      agents: [new RoomAgentDispatch({ agentName: 'spanish-line' })],
    });

    this.room.on(RoomEvent.TrackSubscribed, this.handleTrackSubscribed);
    this.room.on(RoomEvent.ParticipantAttributesChanged, this.handleAttributesChanged);

    await this.room.connect(config.livekit.url, await token.toJwt(), {
      autoSubscribe: true,
      dynacast: false,
    });

    const track = LocalAudioTrack.createAudioTrack('phone', this.source);
    await this.room.localParticipant?.publishTrack(
      track,
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );
  }

  /** Feed one Plivo media payload into the room. */
  pushCallerAudio(payload: Buffer): void {
    if (this.closed) return;

    const samples = this.isMuLaw ? decodeBuffer(payload) : pcm16FromBuffer(payload);
    if (samples.length === 0) return;

    const frame = new AudioFrame(samples, this.opts.sampleRate, 1, samples.length);
    this.captureChain = this.captureChain
      .then(() => (this.closed ? undefined : this.source.captureFrame(frame)))
      .catch((err) => {
        if (!this.closed) console.error(`[${this.opts.callId}] captureFrame failed:`, err);
      });
  }

  /** Forward a DTMF digit to the agent as a room data message. */
  sendDtmf(digit: string): void {
    if (this.closed) return;
    const payload = new TextEncoder().encode(JSON.stringify({ digit }));
    this.room.localParticipant
      ?.publishData(payload, { topic: 'dtmf', reliable: true })
      .catch((err) => console.error(`[${this.opts.callId}] publishData failed:`, err));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.outboundAbort.abort();

    this.room.off(RoomEvent.TrackSubscribed, this.handleTrackSubscribed);
    this.room.off(RoomEvent.ParticipantAttributesChanged, this.handleAttributesChanged);

    // Let any in-flight capture settle before tearing the source down, so the
    // FFI handle is not closed underneath a pending frame.
    await this.captureChain.catch(() => {});
    await this.source.close().catch(() => {});
    await this.room.disconnect().catch(() => {});
  }

  private handleTrackSubscribed = (
    track: RemoteTrack,
    _publication: unknown,
    participant: RemoteParticipant,
  ): void => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    console.log(`[${this.opts.callId}] subscribed to audio from ${participant.identity}`);
    void this.pumpAgentAudio(track);
  };

  /**
   * Barge-in. The agent stops generating the moment the caller interrupts, but
   * Plivo is still holding whatever we already streamed, so that buffer has to
   * be dropped explicitly or the caller hears the tail of a sentence the agent
   * has already abandoned.
   */
  private handleAttributesChanged = (changed: Record<string, string>): void => {
    const next = changed[AGENT_STATE_ATTRIBUTE];
    if (!next) return;

    const wasSpeaking = this.agentState === 'speaking';
    this.agentState = next;

    if (wasSpeaking && next !== 'speaking') {
      this.opts.onClearAudio();
    }
  };

  private async pumpAgentAudio(track: RemoteTrack): Promise<void> {
    // Asking AudioStream for the telephony rate makes it resample the agent's
    // 24/48 kHz TTS output for us, so nothing here has to do rate conversion.
    const stream = new AudioStream(track, {
      sampleRate: this.opts.sampleRate,
      numChannels: 1,
    });

    const reader = stream.getReader();
    const onAbort = () => void reader.cancel().catch(() => {});
    this.outboundAbort.signal.addEventListener('abort', onAbort, { once: true });

    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        const payload = this.isMuLaw
          ? encodeBuffer(value.data)
          : Buffer.from(value.data.buffer, value.data.byteOffset, value.data.byteLength);
        this.opts.onAudio(payload);
      }
    } catch (err) {
      if (!this.closed) console.error(`[${this.opts.callId}] agent audio pump failed:`, err);
    } finally {
      this.outboundAbort.signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
  }
}
