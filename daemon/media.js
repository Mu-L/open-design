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
// entrypoint. Providers are pluggable: each file under ./media-providers/
// (or inline below) registers handlers keyed by (surface, model). The
// fallback handlers emit a deterministic, lightweight placeholder
// (labeled SVG-PNG, silent WAV/MP3, blank MP4) so the framework is
// inspectable for development. They are gated behind the
// OD_MEDIA_ALLOW_STUBS=1 env var; without it, generateMedia throws a
// 503-mapped error instead of writing placeholder bytes that look like
// a "successful" generation. Real provider integrations slot in later
// by replacing the renderer body.

import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AUDIO_DURATIONS_SEC,
  VIDEO_LENGTHS_SEC,
  findMediaModel,
  modelsForSurface,
} from './media-models.js';
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
 * @param {string} args.projectsRoot - Absolute path to <repo>/.od/projects.
 * @param {string} args.projectId
 * @param {'image'|'video'|'audio'} args.surface
 * @param {string} args.model - Must be a registered model id.
 * @param {string} [args.prompt]
 * @param {string} [args.output] - Optional filename; auto-named if missing.
 * @param {string} [args.aspect] - 1:1 / 16:9 / 9:16 / 4:3 / 3:4
 * @param {number} [args.length] - Video length, seconds.
 * @param {number} [args.duration] - Audio duration, seconds.
 * @param {string} [args.voice]
 * @param {string} [args.audioKind] - music | speech | sfx
 * @returns {Promise<{ name: string, size: number, mtime: number, kind: string, mime: string, model: string, surface: string, providerNote: string }>}
 */
export async function generateMedia(args) {
  const {
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
    prompt: prompt || '',
    aspect: aspect || defaultAspectFor(surface),
    length: clampedLength,
    duration: clampedDuration,
    voice: voice || '',
    audioKind: resolvedAudioKind,
  };

  // Real provider integrations slot in here ahead of the stub branch. For
  // now there are none — guard the stubs behind OD_MEDIA_ALLOW_STUBS so a
  // user clicking Generate on a release build sees a clear error instead
  // of a placeholder file landing in the FileViewer.
  if (!stubsAllowed()) {
    throw new StubProviderDisabledError(model);
  }

  let bytes;
  let providerNote;
  if (surface === 'image') {
    ({ bytes, providerNote } = await renderImage(ctx, safeOut));
  } else if (surface === 'video') {
    ({ bytes, providerNote } = await renderVideo(ctx, safeOut));
  } else {
    ({ bytes, providerNote } = await renderAudio(ctx, safeOut));
  }
  // The renderers return their own descriptive note. Prepend a `[stub]`
  // tag so any UI surface (e.g. the FileViewer toolbar) can tell at a
  // glance that the bytes are placeholder, not a real provider call.
  providerNote = `[stub] ${providerNote}`;

  await writeFile(target, bytes);
  const st = await stat(target);
  return {
    name: safeOut,
    size: st.size,
    mtime: st.mtimeMs,
    kind: kindFor(safeOut),
    mime: mimeFor(safeOut),
    model,
    surface,
    providerNote,
  };
}

function autoOutputName(surface, model, audioKind) {
  const base = DEFAULT_OUTPUT_BY_SURFACE[surface] || 'artifact.bin';
  const stamp = Date.now().toString(36);
  const tag = surface === 'audio' && audioKind ? `${audioKind}-${model}` : model;
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
// Provider stubs.
//
// Each renderer returns Buffer bytes that the caller writes to disk. They
// produce real, lightweight placeholder media labelled with the model +
// prompt so the user can verify which call was dispatched while the real
// provider integrations are still pending. To replace a stub with a real
// provider, swap the body — keep the (ctx, fileName) → { bytes, note }
// shape so server.js doesn't change.

async function renderImage(ctx, fileName) {
  // SVG-as-image: write SVG bytes into a .png filename only when ext is
  // svg; otherwise emit a tiny PNG that browsers can decode. We pick
  // PNG-as-bytes by encoding the SVG inside a minimal PNG container —
  // simpler: just write SVG XML into a .png, browsers can't render that.
  // So instead: for png/jpg, emit a deterministic 1×1 PNG; for svg, emit
  // a labelled SVG.
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.svg') {
    return { bytes: Buffer.from(svgPlaceholder(ctx), 'utf8'), providerNote: 'svg-stub' };
  }
  // Minimal 1×1 transparent PNG. Real provider would emit a full image.
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
    providerNote: `stub-png · model=${ctx.model} · aspect=${ctx.aspect} · prompt=${truncate(ctx.prompt, 60)}`,
  };
}

async function renderVideo(ctx, _fileName) {
  // Tiny but valid mp4 (ftyp + minimal moov). Browsers without a video
  // track will show 0 seconds, which is fine — this proves the dispatch
  // round-trip; real Seedance/Kling/Veo providers replace this body.
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
  const mdat = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x6d, 0x64, 0x61, 0x74]);
  return {
    bytes: Buffer.concat([ftyp, mdat]),
    providerNote: `stub-mp4 · model=${ctx.model} · aspect=${ctx.aspect} · length=${ctx.length ?? '?'}s · prompt=${truncate(ctx.prompt, 60)}`,
  };
}

async function renderAudio(ctx, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.wav') {
    return {
      bytes: silentWav(0.5),
      providerNote: `stub-wav · model=${ctx.model} · kind=${ctx.audioKind} · duration=${ctx.duration ?? '?'}s`,
    };
  }
  // Default: emit a near-empty mp3 frame header so the file is valid but
  // tiny. Browsers may report 0:00; replace with real provider output.
  const mp3 = Buffer.from([
    0xff, 0xfb, 0x90, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  return {
    bytes: mp3,
    providerNote: `stub-mp3 · model=${ctx.model} · kind=${ctx.audioKind} · voice=${ctx.voice || '-'} · duration=${ctx.duration ?? '?'}s`,
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
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
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
