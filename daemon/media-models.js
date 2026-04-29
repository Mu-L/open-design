// Daemon-side mirror of src/media/models.ts. We keep this in plain JS so
// node imports are native and the daemon never needs a TS toolchain at
// runtime. The two files are kept in sync by hand — any model added to
// src/media/models.ts must be added here too. Drift is enforced by
// `node scripts/verify-media-models.mjs` (also exposed as
// `npm run verify:media-models`); CI should call it before publish so
// the moment one side adds a model and the other doesn't, the build
// fails with a precise diff.

export const IMAGE_MODELS = [
  { id: 'gpt-image-2', label: 'gpt-image-2', hint: 'OpenAI · default', caps: ['t2i', 'i2i', 'inpaint'] },
  { id: 'flux-1.1-pro', label: 'flux-1.1-pro', hint: 'Black Forest Labs', caps: ['t2i', 'i2i'] },
  { id: 'imagen-4', label: 'imagen-4', hint: 'Google', caps: ['t2i'] },
  { id: 'midjourney-v7', label: 'midjourney-v7', hint: 'Midjourney', caps: ['t2i'] },
];

export const VIDEO_MODELS = [
  { id: 'seedance-2', label: 'seedance-2', hint: 'ByteDance · default', caps: ['t2v', 'i2v'] },
  { id: 'kling-3', label: 'kling-3', hint: 'Kuaishou', caps: ['t2v', 'i2v'] },
  { id: 'kling-4', label: 'kling-4', hint: 'Kuaishou · latest', caps: ['t2v', 'i2v'] },
  { id: 'veo-3', label: 'veo-3', hint: 'Google', caps: ['t2v'] },
  { id: 'sora-2', label: 'sora-2', hint: 'OpenAI', caps: ['t2v'] },
];

export const AUDIO_MODELS_BY_KIND = {
  music: [
    { id: 'suno-v5', label: 'suno-v5', hint: 'Suno · default', caps: ['music'] },
    { id: 'udio-v2', label: 'udio-v2', hint: 'Udio', caps: ['music'] },
    { id: 'lyria-2', label: 'lyria-2', hint: 'Google', caps: ['music'] },
  ],
  speech: [
    { id: 'minimax-tts', label: 'minimax-tts', hint: 'MiniMax · default', caps: ['tts'] },
    { id: 'fish-speech-2', label: 'fish-speech-2', hint: 'FishAudio', caps: ['tts', 'voice-clone'] },
    { id: 'elevenlabs-v3', label: 'elevenlabs-v3', hint: 'ElevenLabs', caps: ['tts', 'voice-clone'] },
  ],
  sfx: [
    { id: 'elevenlabs-sfx', label: 'elevenlabs-sfx', hint: 'ElevenLabs SFX', caps: ['sfx'] },
    { id: 'audiocraft', label: 'audiocraft', hint: 'Meta · open', caps: ['sfx', 'music'] },
  ],
};

export const MEDIA_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
export const VIDEO_LENGTHS_SEC = [3, 5, 8, 10, 15, 30];
export const AUDIO_DURATIONS_SEC = [5, 10, 15, 30, 60, 120];

export function findMediaModel(id) {
  const all = [
    ...IMAGE_MODELS,
    ...VIDEO_MODELS,
    ...AUDIO_MODELS_BY_KIND.music,
    ...AUDIO_MODELS_BY_KIND.speech,
    ...AUDIO_MODELS_BY_KIND.sfx,
  ];
  return all.find((m) => m.id === id) || null;
}

export function modelsForSurface(surface, audioKind) {
  if (surface === 'image') return IMAGE_MODELS;
  if (surface === 'video') return VIDEO_MODELS;
  if (surface === 'audio') {
    const k = audioKind || 'music';
    return AUDIO_MODELS_BY_KIND[k] || AUDIO_MODELS_BY_KIND.music;
  }
  return [];
}
