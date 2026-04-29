// Media-generation dispatcher. The unifying contract is:
//
//   skills + metadata + system-prompt
//        ↓ (the code agent decides what to make)
//   `od media generate --surface … --model … --output … --prompt …`
//        ↓ (this module routes to a provider)
//   bytes written to <projectsRoot>/<projectId>/<output>
//        ↓
//   FileViewer renders it.
//
// Every surface (image / video / audio) flows through this single
// entrypoint. Providers live behind the `provider` field on each model
// entry in media-models.js — when a real integration ships we route to
// it; otherwise we emit a deterministic, lightweight placeholder
// (labelled SVG-PNG, silent WAV/MP3, blank MP4) so the framework works
// without API keys.
//
// Today we ship two real integrations:
//   * provider 'openai'     → OpenAI Images API (gpt-image-* / dall-e-*),
//                              with auto-detection for Azure OpenAI
//                              deployments based on the configured base URL
//   * provider 'volcengine' → Volcengine Ark async tasks API for
//                              Doubao Seedance 2.0 (video) and Seedream
//                              (image)
//
// The fallback stub handlers are gated behind OD_MEDIA_ALLOW_STUBS=1; in
// release builds they throw StubProviderDisabledError (mapped to HTTP
// 503) instead of writing placeholder bytes that look like a successful
// generation. Real-provider failures still produce a stub byte payload
// when stubs are allowed, but they tag the response with providerError
// so the CLI can exit non-zero and the agent can't silently narrate the
// placeholder as the final result.

import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AUDIO_DURATIONS_SEC,
  VIDEO_LENGTHS_SEC,
  findMediaModel,
  findProvider,
  modelsForSurface,
} from './media-models.js';
import { resolveProviderConfig } from './media-config.js';
import {
  ensureProject,
  kindFor,
  mimeFor,
  sanitizeName,
} from './projects.js';

const DEFAULT_OUTPUT_BY_SURFACE = {
  image: 'image.png',
  video: 'video.mp4',
  audio: 'audio.mp3',
};

const SURFACES = new Set(['image', 'video', 'audio']);
const AUDIO_KINDS = new Set(['music', 'speech', 'sfx']);

// Stubs ship a 1×1 PNG / ~24-byte mp4 / silent WAV / single-frame mp3 so
// the dispatch path is exercisable before real provider integrations
// land. On a release build that lands as "successful" but functionally
// empty bytes — confusing to users. We therefore gate the stub renderers
// behind OD_MEDIA_ALLOW_STUBS=1 and otherwise return a 503 (mapped from
// the StubProviderDisabledError thrown below) with a clear message.
class StubProviderDisabledError extends Error {
  constructor(model) {
    super(
      `provider not configured: ${model}. Set OD_MEDIA_ALLOW_STUBS=1 to write a placeholder file.`,
    );
    this.name = 'StubProviderDisabledError';
    this.code = 'STUB_PROVIDER_DISABLED';
    this.status = 503;
  }
}

function stubsAllowed() {
  const v = process.env.OD_MEDIA_ALLOW_STUBS;
  return v === '1' || v === 'true';
}

function clampNumber(value, allowed) {
  // Accept exact registry values; otherwise snap to the nearest allowed
  // bucket so a hallucinated `Number.MAX_SAFE_INTEGER` can't bill an
  // entire month of credits when real providers plug in.
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (allowed.includes(value)) return value;
  let best = allowed[0];
  let bestDiff = Math.abs(value - allowed[0]);
  for (const a of allowed) {
    const d = Math.abs(value - a);
    if (d < bestDiff) {
      best = a;
      bestDiff = d;
    }
  }
  return best;
}

/**
 * Generate a media artifact and write it into the project's files dir.
 *
 * @param {Object} args
 * @param {string} args.projectRoot   - Repo root (.od/ lives directly under).
 * @param {string} args.projectsRoot  - Absolute path to <repo>/.od/projects.
 * @param {string} args.projectId
 * @param {'image'|'video'|'audio'} args.surface
 * @param {string} args.model
 * @param {string} [args.prompt]
 * @param {string} [args.output]
 * @param {string} [args.aspect]
 * @param {number} [args.length]
 * @param {number} [args.duration]
 * @param {string} [args.voice]
 * @param {string} [args.audioKind]
 * @returns {Promise<{ name: string, size: number, mtime: number, kind: string, mime: string, model: string, surface: string, providerNote: string, providerId: string }>}
 */
export async function generateMedia(args) {
  const {
    projectRoot,
    projectsRoot,
    projectId,
    surface,
    model,
    prompt,
    output,
    aspect,
    length,
    duration,
    voice,
    audioKind,
  } = args;

  if (!projectRoot) throw new Error('projectRoot required');
  if (!projectsRoot) throw new Error('projectsRoot required');
  if (typeof projectId !== 'string' || !projectId) {
    throw new Error('projectId required');
  }
  if (!SURFACES.has(surface)) {
    throw new Error(`unsupported surface: ${surface}`);
  }
  if (typeof model !== 'string' || !model) {
    throw new Error('model required');
  }
  if (surface === 'audio' && audioKind && !AUDIO_KINDS.has(audioKind)) {
    throw new Error(
      `unsupported audioKind: ${audioKind}. Allowed: music | speech | sfx.`,
    );
  }
  const def = findMediaModel(model);
  if (!def) {
    throw new Error(
      `unknown model: ${model}. Pass --model from the registered list (see /api/media/models).`,
    );
  }
  // Reject cross-surface combinations (e.g. surface=image + model=seedance-2)
  // here so the dispatcher never silently routes a video model id through
  // the image renderer. We compare against the surface-specific list — for
  // audio we further restrict to the kind-specific bucket so a `music`
  // surface can't bill an `elevenlabs-v3` (speech) call.
  const resolvedAudioKind =
    surface === 'audio' ? audioKind || 'music' : undefined;
  const allowed = modelsForSurface(surface, resolvedAudioKind);
  if (!allowed.some((m) => m.id === model)) {
    const ids = allowed.map((m) => m.id).join(', ');
    const where =
      surface === 'audio' ? `audio · ${resolvedAudioKind}` : surface;
    throw new Error(
      `model "${model}" is not registered for surface "${where}". Allowed: ${ids}.`,
    );
  }

  // Clamp registry-bound numeric inputs to their allowed buckets so a
  // hallucinated --length 9999999 doesn't reach a real provider as-is
  // when stubs are swapped for paid integrations.
  const clampedLength =
    surface === 'video' ? clampNumber(length, VIDEO_LENGTHS_SEC) : undefined;
  const clampedDuration =
    surface === 'audio'
      ? clampNumber(duration, AUDIO_DURATIONS_SEC)
      : undefined;

  const dir = await ensureProject(projectsRoot, projectId);
  const safeOut = sanitizeName(
    output || autoOutputName(surface, model, resolvedAudioKind),
  );
  const target = path.join(dir, safeOut);
  await mkdir(path.dirname(target), { recursive: true });

  const ctx = {
    surface,
    model,
    modelDef: def,
    provider: findProvider(def.provider),
    prompt: prompt || '',
    aspect: aspect || defaultAspectFor(surface),
    length: clampedLength,
    duration: clampedDuration,
    voice: voice || '',
    audioKind: resolvedAudioKind,
  };

  const credentials = await resolveProviderConfig(projectRoot, def.provider);

  let bytes;
  let providerNote;
  let suggestedExt;
  // Tracks whether the bytes came from a real provider call or from the
  // stub fallback. Surfaces in the response so the CLI/agent can tell a
  // legitimate placeholder ("provider not integrated yet") apart from a
  // silent failure ("API call blew up, here's a 67-byte PNG"). Without
  // this flag the chat agent narrates the stub as if it's the expected
  // output, and the user sees a blank file.
  let providerError = null;
  let usedStubFallback = false;
  // True only when the dispatcher intentionally returned a stub because
  // no real renderer is wired up for this (provider, surface) pair.
  let intentionalStub = false;
  try {
    if (def.provider === 'openai' && surface === 'image') {
      const result = await renderOpenAIImage(ctx, credentials);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else if (def.provider === 'volcengine' && surface === 'video') {
      const result = await renderVolcengineVideo(ctx, credentials);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else if (def.provider === 'volcengine' && surface === 'image') {
      const result = await renderVolcengineImage(ctx, credentials);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else if (def.provider === 'minimax' && surface === 'audio') {
      const result = await renderMinimaxTTS(ctx, credentials);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else if (def.provider === 'fishaudio' && surface === 'audio') {
      const result = await renderFishAudioTTS(ctx, credentials);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else {
      // No real renderer wired up for this (provider, surface). Gate the
      // stub fallback behind OD_MEDIA_ALLOW_STUBS so release builds don't
      // silently write placeholder bytes to disk and confuse the user.
      if (!stubsAllowed()) {
        throw new StubProviderDisabledError(model);
      }
      const result = await renderStub(ctx, safeOut);
      bytes = result.bytes;
      providerNote = result.providerNote;
      intentionalStub = true;
    }
  } catch (err) {
    // Stub-disabled errors are intentional — propagate so the daemon
    // maps them to 503 and the CLI surfaces a clear "configure a real
    // provider" message rather than writing fake bytes.
    if (err instanceof StubProviderDisabledError) {
      throw err;
    }
    // A real provider failed (network blip, 4xx, missing key, …). We
    // still want to fall back to a stub so the agent's chat loop
    // doesn't dead-end — but only when stubs are allowed for this
    // build. Otherwise re-throw so the CLI exits non-zero with the
    // real upstream message.
    if (!stubsAllowed()) {
      throw err;
    }
    const stub = await renderStub(ctx, safeOut);
    bytes = stub.bytes;
    const msg = err && err.message ? err.message : String(err);
    providerNote = `[${def.provider} error → stub] ${msg}`;
    providerError = msg;
    usedStubFallback = true;
    // Also log to daemon stderr so the failure is visible in the daemon
    // terminal — easiest place for the developer/operator to spot it.
    try {
      console.error(
        `[media] ${def.provider}/${surface}/${model} failed: ${msg}`,
      );
    } catch {
      // best-effort logging only
    }
  }
  // Tag the providerNote with `[stub]` only when the bytes actually came
  // from the stub renderer — either as the intentional fallback for an
  // unintegrated (provider, surface) pair, or because a real-provider
  // call failed and we wrote a placeholder. Real-provider successes keep
  // the renderer's own note (e.g. "openai/gpt-image-2 · 1:1 · 1.2 MB")
  // untouched so the FileViewer toolbar shows the truth.
  if (intentionalStub || usedStubFallback) {
    providerNote = `[stub] ${providerNote}`;
  }

  // If the real provider returned a different extension than the
  // requested filename, swap it. Saves the agent from having to guess
  // (.png vs .jpg vs .webp) before it knows what the model emits.
  let finalOut = safeOut;
  if (suggestedExt) {
    const dot = safeOut.lastIndexOf('.');
    const stem = dot > 0 ? safeOut.slice(0, dot) : safeOut;
    finalOut = `${stem}${suggestedExt}`;
  }
  const finalTarget = path.join(dir, finalOut);
  await writeFile(finalTarget, bytes);
  const st = await stat(finalTarget);
  return {
    name: finalOut,
    size: st.size,
    mtime: st.mtimeMs,
    kind: kindFor(finalOut),
    mime: mimeFor(finalOut),
    model,
    surface,
    providerNote,
    providerId: def.provider,
    providerError,
    usedStubFallback,
    intentionalStub,
  };
}

function autoOutputName(surface, model, audioKind) {
  const base = DEFAULT_OUTPUT_BY_SURFACE[surface] || 'artifact.bin';
  const stamp = Date.now().toString(36);
  // Slug the model id so the filename stays short and shell-safe.
  const slug = String(model).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
  const tag = surface === 'audio' && audioKind ? `${audioKind}-${slug}` : slug;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return `${stem}-${tag}-${stamp}${ext}`;
}

function defaultAspectFor(surface) {
  if (surface === 'image') return '1:1';
  if (surface === 'video') return '16:9';
  return undefined;
}

// ---------------------------------------------------------------------------
// Provider: OpenAI Images API (gpt-image-2, gpt-image-1.5, dall-e-3 …)
//
// We support both the canonical OpenAI endpoint AND Azure-hosted
// OpenAI deployments behind the same provider slot — Azure is detected
// from the base URL (`*.azure.com` host or a `/deployments/<name>`
// segment in the path). For Azure we additionally:
//   * append `?api-version=…` (default 2024-02-01, unless the user has
//     already encoded one into the base URL),
//   * send the api-key header in addition to Authorization (Azure
//     accepts either; some setups only honor api-key),
//   * drop the `model` field from the body since the deployment in the
//     path already names the model.
// ---------------------------------------------------------------------------

const AZURE_DEFAULT_API_VERSION = '2024-02-01';

async function renderOpenAIImage(ctx, credentials) {
  if (!credentials.apiKey) {
    throw new Error('no OpenAI API key — configure it in Settings or set OPENAI_API_KEY');
  }
  const rawBase = credentials.baseUrl || 'https://api.openai.com/v1';
  const azure = detectAzureEndpoint(rawBase);
  const url = buildOpenAIImageUrl(rawBase, azure);

  const body = {
    prompt: ctx.prompt || 'A high-quality reference image.',
    n: 1,
    size: openaiSizeFor(ctx.model, ctx.aspect),
  };
  // For non-Azure calls, include `model` in the body. Azure infers it
  // from the deployment in the path so omitting it keeps payloads
  // compatible across both flavors.
  if (!azure) {
    body.model = ctx.model;
  }
  // gpt-image-* returns b64_json by default and rejects response_format,
  // so we only pass it for dall-e-* (where it's required).
  if (ctx.model.startsWith('dall-e-')) {
    body.response_format = 'b64_json';
    body.quality = ctx.model === 'dall-e-3' ? 'hd' : 'standard';
  } else {
    // gpt-image-* accepts quality 'high' | 'medium' | 'low'.
    body.quality = 'high';
  }

  const headers = {
    'authorization': `Bearer ${credentials.apiKey}`,
    'content-type': 'application/json',
  };
  if (azure) {
    // Azure's canonical auth header. Some deployments accept Bearer
    // (the curl example we tested against does) but api-key is what
    // their docs document, so send both. OpenAI ignores unknown
    // headers, so this is harmless on the standard endpoint too.
    headers['api-key'] = credentials.apiKey;
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    const tag = azure ? 'azure-openai' : 'openai';
    throw new Error(`${tag} ${resp.status}: ${truncate(text, 240)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`openai non-JSON response: ${truncate(text, 200)}`);
  }
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry) throw new Error('openai response had no data[0]');
  let bytes;
  if (entry.b64_json) {
    bytes = Buffer.from(entry.b64_json, 'base64');
  } else if (entry.url) {
    const imgResp = await fetch(entry.url);
    if (!imgResp.ok) throw new Error(`openai image fetch ${imgResp.status}`);
    const arr = await imgResp.arrayBuffer();
    bytes = Buffer.from(arr);
  } else {
    throw new Error('openai response had neither b64_json nor url');
  }

  const tag = azure ? 'azure-openai' : 'openai';
  return {
    bytes,
    providerNote: `${tag}/${ctx.model} · ${ctx.aspect} · ${bytes.length} bytes`,
    suggestedExt: '.png',
  };
}

/**
 * Heuristic: do we think this base URL points at an Azure OpenAI
 * deployment rather than the public OpenAI API?
 *
 *   true examples
 *     https://x.cognitiveservices.azure.com/openai/deployments/gpt-image-2
 *     https://x.openai.azure.com/openai/deployments/foo
 *     /openai/deployments/foo?api-version=2024-02-01
 *   false examples
 *     https://api.openai.com/v1
 *     http://localhost:8080/v1
 */
function detectAzureEndpoint(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl) return false;
  if (/\.azure\.com\b/i.test(baseUrl)) return true;
  if (/\/openai\/deployments\//i.test(baseUrl)) return true;
  return false;
}

/**
 * Build the full /images/generations URL, preserving any user-supplied
 * query string (e.g. an explicit `?api-version=2024-12-01`) and
 * appending the default api-version for Azure when the user didn't
 * specify one. Returns a string ready for `fetch`.
 */
function buildOpenAIImageUrl(baseUrl, isAzure) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // Bad URL — fall back to naive concat so the upstream error is
    // surfaced through the normal HTTP path rather than a parse crash.
    const stripped = baseUrl.replace(/\/$/, '');
    return `${stripped}/images/generations`;
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/images/generations';
  if (isAzure && !parsed.searchParams.has('api-version')) {
    parsed.searchParams.set('api-version', AZURE_DEFAULT_API_VERSION);
  }
  return parsed.toString();
}

function openaiSizeFor(model, aspect) {
  // gpt-image-1.5 / gpt-image-2 accept arbitrary sizes up to 4096; we
  // pick concrete ones tuned to common aspects so the API never
  // negotiates them down silently.
  if (model.startsWith('gpt-image-')) {
    if (aspect === '16:9') return '1792x1024';
    if (aspect === '9:16') return '1024x1792';
    if (aspect === '4:3') return '1408x1056';
    if (aspect === '3:4') return '1056x1408';
    return '1024x1024';
  }
  if (model === 'dall-e-3') {
    if (aspect === '16:9') return '1792x1024';
    if (aspect === '9:16') return '1024x1792';
    return '1024x1024';
  }
  // dall-e-2 only supports 256/512/1024 squares.
  return '1024x1024';
}

// ---------------------------------------------------------------------------
// Provider: Volcengine Ark — Doubao Seedance 2.0 video.
//
// Docs:
//   POST /api/v3/contents/generations/tasks   → { id }
//   GET  /api/v3/contents/generations/tasks/{id} → { status, content: { video_url } }
// We submit, poll until succeeded/failed, then fetch the produced
// video_url and return the raw bytes. The temporary URL Volcengine
// returns is only valid for ~24h, so streaming the bytes into the
// project folder is required to keep them addressable.
// ---------------------------------------------------------------------------

async function renderVolcengineVideo(ctx, credentials) {
  if (!credentials.apiKey) {
    throw new Error(
      'no Volcengine Ark API key — configure it in Settings or set ARK_API_KEY',
    );
  }
  const baseUrl = (credentials.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');

  // Seedance accepts inline `--resolution`, `--duration`, `--ratio` and
  // `--camerafixed` flags inside the prompt text. We append a flags
  // suffix so user prompts that already contain them still win.
  const ratio = volcengineRatioFor(ctx.aspect);
  const durationSec = ctx.length || 5;
  const resolution = '720p';
  const promptText = (ctx.prompt && ctx.prompt.trim()) || 'A short cinematic clip.';
  const suffixFlags = [];
  if (!/--resolution\b/.test(promptText)) suffixFlags.push(`--resolution ${resolution}`);
  if (!/--duration\b/.test(promptText)) suffixFlags.push(`--duration ${durationSec}`);
  if (!/--ratio\b/.test(promptText)) suffixFlags.push(`--ratio ${ratio}`);
  const fullText = suffixFlags.length
    ? `${promptText} ${suffixFlags.join(' ')}`
    : promptText;

  const taskBody = {
    model: ctx.model,
    content: [{ type: 'text', text: fullText }],
  };

  const taskResp = await fetch(`${baseUrl}/contents/generations/tasks`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${credentials.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(taskBody),
  });
  const taskText = await taskResp.text();
  if (!taskResp.ok) {
    throw new Error(`volcengine task create ${taskResp.status}: ${truncate(taskText, 240)}`);
  }
  let taskData;
  try {
    taskData = JSON.parse(taskText);
  } catch {
    throw new Error(`volcengine non-JSON: ${truncate(taskText, 200)}`);
  }
  const taskId = taskData && taskData.id;
  if (!taskId) throw new Error('volcengine task response missing id');

  // Poll until succeeded/failed. Cap at ~3 minutes — Seedance 2.0 fast
  // returns in 30-60s, the standard model can take 90-120s.
  const startedAt = Date.now();
  const maxMs = 3 * 60 * 1000;
  let videoUrl = null;
  let lastStatus = '';
  while (Date.now() - startedAt < maxMs) {
    await sleep(4000);
    const pollResp = await fetch(`${baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
      headers: { 'authorization': `Bearer ${credentials.apiKey}` },
    });
    const pollText = await pollResp.text();
    if (!pollResp.ok) {
      throw new Error(`volcengine poll ${pollResp.status}: ${truncate(pollText, 240)}`);
    }
    let pollData;
    try {
      pollData = JSON.parse(pollText);
    } catch {
      throw new Error(`volcengine poll non-JSON: ${truncate(pollText, 200)}`);
    }
    lastStatus = pollData.status || '';
    if (lastStatus === 'succeeded') {
      videoUrl = pollData?.content?.video_url || null;
      break;
    }
    if (lastStatus === 'failed' || lastStatus === 'cancelled') {
      const reason = pollData?.error?.message || lastStatus;
      throw new Error(`volcengine task ${lastStatus}: ${reason}`);
    }
  }
  if (!videoUrl) {
    throw new Error(`volcengine task did not finish in time (last status: ${lastStatus || 'unknown'})`);
  }

  const dlResp = await fetch(videoUrl);
  if (!dlResp.ok) throw new Error(`volcengine video fetch ${dlResp.status}`);
  const arr = await dlResp.arrayBuffer();
  const bytes = Buffer.from(arr);

  return {
    bytes,
    providerNote: `volcengine/${ctx.model} · ${ratio} · ${durationSec}s · ${bytes.length} bytes`,
    suggestedExt: '.mp4',
  };
}

function volcengineRatioFor(aspect) {
  // Seedance accepts a fixed list of ratios; map the OD vocabulary to
  // its canonical strings.
  if (!aspect) return '16:9';
  if (aspect === '1:1' || aspect === '16:9' || aspect === '9:16' || aspect === '4:3' || aspect === '3:4') {
    return aspect;
  }
  return '16:9';
}

// Volcengine Seedream / Seededit images. Same auth, different endpoint:
// POST /api/v3/images/generations (OpenAI-compatible payload).
async function renderVolcengineImage(ctx, credentials) {
  if (!credentials.apiKey) {
    throw new Error('no Volcengine Ark API key — configure it in Settings or set ARK_API_KEY');
  }
  const baseUrl = (credentials.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');

  const body = {
    model: ctx.model,
    prompt: ctx.prompt || 'A high-quality reference image.',
    response_format: 'b64_json',
    size: openaiSizeFor(ctx.model, ctx.aspect),
  };
  const resp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${credentials.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`volcengine image ${resp.status}: ${truncate(text, 240)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`volcengine image non-JSON: ${truncate(text, 200)}`);
  }
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry) throw new Error('volcengine image response had no data[0]');
  let bytes;
  if (entry.b64_json) {
    bytes = Buffer.from(entry.b64_json, 'base64');
  } else if (entry.url) {
    const imgResp = await fetch(entry.url);
    if (!imgResp.ok) throw new Error(`volcengine image fetch ${imgResp.status}`);
    bytes = Buffer.from(await imgResp.arrayBuffer());
  } else {
    throw new Error('volcengine image response missing b64_json/url');
  }
  return {
    bytes,
    providerNote: `volcengine/${ctx.model} · ${ctx.aspect} · ${bytes.length} bytes`,
    suggestedExt: '.png',
  };
}

// ---------------------------------------------------------------------------
// Provider: MiniMax — Speech-02 family text-to-speech (synchronous).
//
// Docs: https://platform.minimaxi.com — POST /t2a_v2 with a JSON body
// describing the voice + audio settings. Response is JSON with the
// audio bytes hex-encoded under `data.audio`. The MiniMax catalogue we
// surface as the generic id `minimax-tts` resolves to `speech-02-turbo`
// (their fast tier). Voice id defaults to a neutral Mandarin voice but
// the agent can override via the model registry's `voice` slot.
// ---------------------------------------------------------------------------

const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimaxi.chat/v1';

// Map our generic catalogue ids onto MiniMax's actual model ids. The
// `minimax-tts` slot in src/media/models.ts is shorthand for "their
// fast TTS tier"; we substitute the real model name on the wire so
// MiniMax accepts the request without exposing the user to their
// internal naming.
const MINIMAX_TTS_MODEL_MAP = {
  'minimax-tts': 'speech-02-turbo',
};

async function renderMinimaxTTS(ctx, credentials) {
  if (!credentials.apiKey) {
    throw new Error(
      'no MiniMax API key — configure it in Settings or set OD_MINIMAX_API_KEY',
    );
  }
  const baseUrl = (credentials.baseUrl || MINIMAX_DEFAULT_BASE_URL).replace(
    /\/$/,
    '',
  );
  const wireModel = MINIMAX_TTS_MODEL_MAP[ctx.model] || ctx.model;
  const text = (ctx.prompt && ctx.prompt.trim()) || 'This is a test.';
  // Voice id picks: the agent can pass --voice to choose, otherwise we
  // default to a neutral Mandarin male voice that handles both Chinese
  // and English text reasonably. MiniMax's voice catalogue is large
  // (`male-qn-qingse`, `female-shaonv`, etc.) — listed at
  // platform.minimaxi.com under voice management.
  const voiceId = (ctx.voice && ctx.voice.trim()) || 'male-qn-qingse';

  const body = {
    model: wireModel,
    text,
    stream: false,
    voice_setting: {
      voice_id: voiceId,
      speed: 1.0,
      vol: 1.0,
      pitch: 0,
    },
    audio_setting: {
      sample_rate: 32000,
      format: 'mp3',
    },
  };

  const resp = await fetch(`${baseUrl}/t2a_v2`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credentials.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const respText = await resp.text();
  if (!resp.ok) {
    throw new Error(`minimax tts ${resp.status}: ${truncate(respText, 240)}`);
  }
  let data;
  try {
    data = JSON.parse(respText);
  } catch {
    throw new Error(`minimax tts non-JSON: ${truncate(respText, 200)}`);
  }
  // MiniMax wraps every response in `base_resp`; even an HTTP 200 can
  // be a logical failure (`status_code !== 0`). Surface that distinct
  // class of error so the user knows it's an auth / params issue, not
  // a network blip.
  if (data?.base_resp && data.base_resp.status_code !== 0) {
    throw new Error(
      `minimax tts api error ${data.base_resp.status_code}: ${data.base_resp.status_msg || 'unknown'}`,
    );
  }
  const hex = data?.data?.audio;
  if (typeof hex !== 'string' || !hex) {
    throw new Error('minimax tts response missing data.audio');
  }
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length === 0) {
    throw new Error('minimax tts decoded zero bytes');
  }
  // Pull a few useful descriptors from extra_info for the providerNote
  // so the FileViewer toolbar tells the truth about what was generated.
  const xi = data?.extra_info || {};
  const seconds = xi.audio_length ? Math.round(xi.audio_length / 100) / 10 : '?';

  return {
    bytes,
    providerNote: `minimax/${wireModel} · ${voiceId} · ${seconds}s · ${bytes.length} bytes`,
    suggestedExt: '.mp3',
  };
}

// ---------------------------------------------------------------------------
// Provider: FishAudio — Speech-1.x family text-to-speech (synchronous).
//
// Docs: https://docs.fish.audio — POST /v1/tts with a JSON body.
// FishAudio returns the audio bytes directly (Content-Type: audio/mpeg
// for mp3, audio/wav for wav) rather than wrapping them in JSON, so we
// stream the body straight into a Buffer. The catalogue id we expose
// as `fish-speech-2` resolves to `speech-1.6` (their newer model) on
// the wire; older builds can paste `speech-1.5` via the model picker
// once arbitrary model ids are accepted.
// ---------------------------------------------------------------------------

const FISHAUDIO_DEFAULT_BASE_URL = 'https://api.fish.audio';

const FISHAUDIO_TTS_MODEL_MAP = {
  'fish-speech-2': 'speech-1.6',
};

async function renderFishAudioTTS(ctx, credentials) {
  if (!credentials.apiKey) {
    throw new Error(
      'no FishAudio API key — configure it in Settings or set OD_FISHAUDIO_API_KEY',
    );
  }
  const baseUrl = (credentials.baseUrl || FISHAUDIO_DEFAULT_BASE_URL).replace(
    /\/$/,
    '',
  );
  const wireModel = FISHAUDIO_TTS_MODEL_MAP[ctx.model] || ctx.model;
  const text = (ctx.prompt && ctx.prompt.trim()) || 'This is a test.';

  // FishAudio's `reference_id` slot pins which voice the synth uses.
  // The agent passes it via --voice (carried in ctx.voice). Empty means
  // FishAudio falls back to its default voice for the chosen model.
  const body = {
    text,
    format: 'mp3',
    mp3_bitrate: 128,
    model: wireModel,
    normalize: true,
    latency: 'normal',
  };
  if (ctx.voice && ctx.voice.trim()) {
    body.reference_id = ctx.voice.trim();
  }

  const resp = await fetch(`${baseUrl}/v1/tts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credentials.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`fishaudio tts ${resp.status}: ${truncate(errText, 240)}`);
  }
  const arr = await resp.arrayBuffer();
  const bytes = Buffer.from(arr);
  if (bytes.length === 0) {
    throw new Error('fishaudio tts returned zero bytes');
  }
  return {
    bytes,
    providerNote: `fishaudio/${wireModel} · ${bytes.length} bytes`,
    suggestedExt: '.mp3',
  };
}

// ---------------------------------------------------------------------------
// Stub renderer.
//
// Used when no real provider integration ships for (provider, surface)
// or when the real one fails. Produces small but valid bytes so the
// downstream FileViewer round-trip works while the backend matures.
// ---------------------------------------------------------------------------

async function renderStub(ctx, fileName) {
  const note = ctx.provider && !ctx.provider.integrated
    ? `stub-${ctx.surface} · provider '${ctx.provider.id}' integration pending`
    : `stub-${ctx.surface} · model=${ctx.model}`;
  if (ctx.surface === 'image') {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.svg') {
      return { bytes: Buffer.from(svgPlaceholder(ctx), 'utf8'), providerNote: note };
    }
    const png = Buffer.from(
      [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ],
    );
    return {
      bytes: png,
      providerNote: `${note} · aspect=${ctx.aspect} · prompt=${truncate(ctx.prompt, 60)}`,
    };
  }
  if (ctx.surface === 'video') {
    const ftyp = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
    ]);
    const mdat = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x6d, 0x64, 0x61, 0x74]);
    return {
      bytes: Buffer.concat([ftyp, mdat]),
      providerNote: `${note} · aspect=${ctx.aspect} · length=${ctx.length ?? '?'}s · prompt=${truncate(ctx.prompt, 60)}`,
    };
  }
  // Audio
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.wav') {
    return {
      bytes: silentWav(0.5),
      providerNote: `${note} · kind=${ctx.audioKind} · duration=${ctx.duration ?? '?'}s`,
    };
  }
  const mp3 = Buffer.from([
    0xff, 0xfb, 0x90, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  return {
    bytes: mp3,
    providerNote: `${note} · kind=${ctx.audioKind} · voice=${ctx.voice || '-'} · duration=${ctx.duration ?? '?'}s`,
  };
}

function svgPlaceholder(ctx) {
  const [w, h] = aspectToBox(ctx.aspect, 800);
  const safe = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
    `<rect width="${w}" height="${h}" fill="#0f1424"/>`,
    `<text x="50%" y="50%" fill="#7da4ff" font-family="ui-sans-serif" font-size="20" text-anchor="middle">${safe(ctx.model)} — ${safe(ctx.prompt).slice(0, 60)}</text>`,
    '</svg>',
  ].join('');
}

function aspectToBox(aspect, base) {
  const [a, b] = String(aspect || '1:1').split(':').map(Number);
  if (!a || !b) return [base, base];
  if (a >= b) return [base, Math.round((base * b) / a)];
  return [Math.round((base * a) / b), base];
}

function silentWav(seconds) {
  const sampleRate = 8000;
  const numSamples = Math.max(1, Math.round(sampleRate * seconds));
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function truncate(s, n) {
  const v = String(s || '');
  if (v.length <= n) return v;
  return v.slice(0, n - 1) + '…';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
