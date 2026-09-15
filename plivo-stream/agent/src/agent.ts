import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ServerOptions,
  cli,
  defineAgent,
  llm,
  voice,
  type JobContext,
  type JobProcess,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { createSpekoComponents } from '@spekoai/adapter-livekit';
import { Speko } from '@spekoai/sdk';
import { z } from 'zod';

import { deliver } from './delivery.js';
import { toE164, type CallRecord, type Intake } from './intake.js';

const SPEKO_API_KEY = process.env.SPEKO_API_KEY;
if (!SPEKO_API_KEY) throw new Error('Missing SPEKO_API_KEY');

const SPEKO_BASE_URL = process.env.SPEKO_BASE_URL ?? 'https://api.speko.dev';
const BUSINESS_NAME = process.env.BUSINESS_NAME ?? 'nuestra oficina';

/**
 * The business owner maintains this file in English (easier for them); the
 * agent translates on the fly when it speaks. It lives at the repo root, one
 * level above both `agent/` and the bridge's `src/`, so it is obviously not
 * owned by either process.
 */
const AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_PATH = process.env.BUSINESS_KNOWLEDGE_PATH ?? resolve(AGENT_DIR, '..', '..', 'business.md');

const BUSINESS_KNOWLEDGE = loadBusinessKnowledge(KNOWLEDGE_PATH);

/**
 * Reads the knowledge file and warns at startup about every `[FILL IN]` left
 * in it — those are the questions the agent will decline to guess at, so the
 * owner should see the list without having to read the whole file themselves.
 */
function loadBusinessKnowledge(path: string): string {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read business knowledge file at ${path} (set BUSINESS_KNOWLEDGE_PATH to override): ${
        (err as Error).message
      }`,
    );
  }

  const unfilled = content
    .split('\n')
    .map((line, i) => ({ text: line.trim(), num: i + 1 }))
    .filter(({ text }) => text.includes('[FILL IN'));

  if (unfilled.length > 0) {
    console.warn(`[business.md] ${unfilled.length} unanswered item(s) — the agent will take a message for these instead of guessing:`);
    for (const { text, num } of unfilled) console.warn(`  line ${num}: ${text}`);
  } else {
    console.log('[business.md] loaded, no unanswered items.');
  }

  return content;
}

const INSTRUCTIONS = `Eres el asistente telefónico de ${BUSINESS_NAME}. Hablas
solamente español, con acento neutro y trato de usted.

Tienes dos trabajos: responder preguntas sobre el negocio usando SOLO la
información de referencia de abajo, y tomar un recado con el nombre de quien
llama, un número de contacto, y lo que necesita.

--- INFORMACIÓN DEL NEGOCIO (en inglés; tradúcela al español al hablar) ---
${BUSINESS_KNOWLEDGE}
--- FIN DE LA INFORMACIÓN ---

Reglas para usar la información de arriba:
- Si la respuesta a lo que preguntan está ahí, contéstala de forma natural y
  breve, en español, sin mencionar que estás leyendo un documento.
- Si el tema dice "[FILL IN]", o simplemente no aparece ahí, NO la inventes, NO
  estimes, NO digas "probablemente". Di que un representante les llamará con
  esa información, y sigue adelante con el recado.
- Nunca des ni un precio aproximado, ni una fecha de entrega concreta, ni
  confirmes disponibilidad de un contenedor específico, ni digas si un permiso
  aplica a una dirección concreta — todo eso lo resuelve un representante por
  teléfono.

No resuelvas el problema del cliente ni prometas nada fuera de lo anterior. Si
insisten, di que la persona encargada les devolverá la llamada.

Para el recado, pide una cosa a la vez, en este orden:
1. Su nombre.
2. El número al que quieren que les devuelvan la llamada. Si dicen que es el
   mismo desde el que llaman, acéptalo sin pedir los dígitos.
3. En qué les podemos ayudar.

Puedes responder preguntas antes o durante estos tres pasos si te las hacen;
luego retoma el recado justo donde ibas.

Habla como se habla por teléfono: frases cortas, palabras sencillas, una idea a
la vez. Nunca uses listas, viñetas ni formato de pantalla — todo lo que digas se
convierte en voz.

La línea puede fallar. Si no entendiste algo, dilo y pide que lo repitan en vez
de adivinar. Repite los números de teléfono dígito por dígito para confirmarlos.

Cuando tengas las tres cosas del recado, repite el recado completo y pregunta
si está correcto. Solo después de que digan que sí, llama a la herramienta
guardar_recado. Luego despídete brevemente y termina.

Si la persona se niega a dar algún dato, guarda lo que tengas y marca
confirmado como falso.`;

export default defineAgent({
  /**
   * Loading Silero costs a second or two, so it happens once per worker process
   * rather than once per call — a caller would hear that delay as dead air.
   */
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const speko = new Speko({ apiKey: SPEKO_API_KEY, baseUrl: SPEKO_BASE_URL });
    const vad = ctx.proc.userData.vad as silero.VAD;

    const caller = await ctx.waitForParticipant();
    const callerNumber = caller.attributes['plivo.from'] ?? '';
    const dialedNumber = caller.attributes['plivo.to'] ?? '';
    const callId = caller.attributes['plivo.callId'] ?? ctx.room.name ?? 'unknown';
    const startedAt = new Date().toISOString();

    console.log(`[${callId}] call from ${callerNumber || 'unknown'}`);

    // Filled in by the tool below. Held here rather than in session state so the
    // shutdown callback can still read it after the session tears down.
    let captured: Intake | undefined;

    // Every turn, regardless of whether the caller ever reaches the intake
    // tool — a dropped call still leaves a transcript worth emailing.
    const transcript: string[] = [];

    const guardarRecado = llm.tool({
      name: 'guardar_recado',
      description:
        'Guarda el recado del cliente. Llámala una sola vez, después de que el cliente confirme que los datos están correctos.',
      parameters: z.object({
        nombre: z.string().describe('Nombre del cliente tal como lo dijo.'),
        telefono: z
          .string()
          .describe(
            'Número para devolver la llamada, en dígitos. Si el cliente dijo que es el mismo desde el que llama, escribe "mismo".',
          ),
        peticion: z
          .string()
          .describe('Lo que necesita el cliente, en sus propias palabras, en español.'),
        peticion_en_ingles: z
          .string()
          .describe(
            'La misma petición traducida al inglés, natural y completa. Incluye cualquier detalle relevante de la conversación.',
          ),
        confirmado: z
          .boolean()
          .describe('true si el cliente confirmó que los datos están correctos.'),
      }),
      execute: async (args) => {
        // "mismo" (and an unparseable number) falls back to caller ID rather
        // than storing a garbled string — a wrong callback number is worse than
        // no override.
        const spoken = args.telefono.trim().toLowerCase();
        const parsed = spoken === 'mismo' ? undefined : toE164(args.telefono);

        captured = {
          name: args.nombre.trim(),
          callbackNumber: parsed ?? callerNumber,
          requestSpanish: args.peticion.trim(),
          requestEnglish: args.peticion_en_ingles.trim(),
          confirmed: args.confirmado,
        };

        console.log(`[${callId}] captured message from ${captured.name}`);
        return 'Recado guardado. Despídete brevemente y termina la llamada.';
      },
    });

    // Speko picks STT/LLM/TTS per call and handles failover server-side, so no
    // provider keys are shipped here. 'cost' pins the cheapest tier.
    const { stt, llm: spekoLlm, tts } = createSpekoComponents({
      speko,
      vad,
      intent: { language: 'es', optimizeFor: 'cost' },
      sttBaseUrl: SPEKO_BASE_URL,
      sttApiKey: SPEKO_API_KEY,
    });

    const session = new voice.AgentSession({
      vad,
      stt,
      llm: spekoLlm,
      tts,
      // A caller gathering their thoughts is not a caller who hung up.
      userAwayTimeout: 30,
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) console.log(`[${callId}] caller: ${ev.transcript}`);
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (!('role' in item)) return; // AgentHandoffItem carries no speech
      if (item.role !== 'user' && item.role !== 'assistant') return;
      const text = item.textContent;
      if (!text?.trim()) return;
      transcript.push(`${item.role === 'user' ? 'Caller' : 'Agent'}: ${text.trim()}`);
    });

    /**
     * Translated once at hangup rather than per-turn — one call with the full
     * transcript as context produces a more coherent translation than
     * stitching together per-sentence translations, and costs one completion
     * instead of dozens.
     */
    async function translateTranscript(text: string): Promise<string> {
      if (!text.trim()) return '';
      try {
        const result = await speko.complete({
          intent: { language: 'en', optimizeFor: 'cost' },
          systemPrompt:
            'Translate this Spanish phone call transcript to English. Keep the "Caller:"/"Agent:" labels and line breaks. Output only the translated transcript, nothing else.',
          messages: [{ role: 'user', content: text }],
        });
        return result.text.trim();
      } catch (err) {
        console.error(`[${callId}] transcript translation failed:`, (err as Error).message);
        return '';
      }
    }

    /**
     * Delivery runs at shutdown, not inside the tool, so a caller who confirms
     * and then immediately hangs up still gets their message through — and so a
     * slow SMTP server never holds up the goodbye. It always fires, even when
     * the intake tool never ran, because the transcript alone is still worth
     * emailing to the owner.
     */
    ctx.addShutdownCallback(async () => {
      const transcriptSpanish = transcript.join('\n');
      const transcriptEnglish = await translateTranscript(transcriptSpanish);

      const record: CallRecord = {
        name: captured?.name ?? '',
        callbackNumber: captured?.callbackNumber ?? '',
        requestSpanish: captured?.requestSpanish ?? '',
        requestEnglish: captured?.requestEnglish ?? '',
        confirmed: captured?.confirmed ?? false,
        callId,
        callerNumber,
        dialedNumber,
        startedAt,
        endedAt: new Date().toISOString(),
        transcriptSpanish,
        transcriptEnglish,
      };

      if (!captured) console.log(`[${callId}] call ended with no message captured; sending transcript only`);

      const outcome = await deliver(record);
      console.log(`[${callId}] delivery:`, JSON.stringify(outcome));
      if (outcome.errors.length > 0) {
        console.error(`[${callId}] delivery errors:`, outcome.errors.join('; '));
      }
    });

    await session.start({
      agent: new voice.Agent({
        instructions: INSTRUCTIONS,
        // Array form, because the tool carries its own name. The object-map
        // shorthand is only for anonymous tools, where the key supplies it.
        tools: [guardarRecado],
      }),
      room: ctx.room,
    });

    session.generateReply({
      instructions: `Saluda en español, di que llamaron a ${BUSINESS_NAME}, y pregunta el nombre de la persona. Una o dos frases.`,
    });
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Named explicitly because a second, unrelated agent worker (the English
  // demo line) registers against this same LiveKit project. Without a name
  // here, LiveKit auto-dispatches each new room to whichever generic worker
  // is free — which is how Spanish calls could end up answered in English.
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: 'spanish-line' }));
}
