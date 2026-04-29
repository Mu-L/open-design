import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import {
  AUDIO_MODELS_BY_KIND,
  DEFAULT_AUDIO_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  VIDEO_MODELS,
} from '../media/models';
import type {
  AudioKind,
  DesignSystemSummary,
  MediaAspect,
  ProjectKind,
  ProjectMetadata,
  ProjectTemplate,
  SkillSummary,
  Surface,
} from '../types';
import { Icon } from './Icon';
import { Skeleton } from './Loading';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

// Tabs that live INSIDE the Web surface. Image / Video / Audio surfaces
// don't expose a tab row — they each have a single, dedicated form.
export type CreateTab = 'prototype' | 'deck' | 'template' | 'other';

export interface CreateInput {
  name: string;
  skillId: string | null;
  designSystemId: string | null;
  metadata: ProjectMetadata;
}

interface Props {
  skills: SkillSummary[];
  designSystems: DesignSystemSummary[];
  defaultDesignSystemId: string | null;
  templates: ProjectTemplate[];
  onCreate: (input: CreateInput) => void;
  loading?: boolean;
}

const TAB_LABEL_KEYS: Record<CreateTab, keyof Dict> = {
  prototype: 'newproj.tabPrototype',
  deck: 'newproj.tabDeck',
  template: 'newproj.tabTemplate',
  other: 'newproj.tabOther',
};

// Per-surface model lists are maintained in src/media/models.ts (and
// daemon/media-models.js for the dispatcher). Both the picker below and
// the agent's `od media generate --model …` invocation read the same
// registry so the metadata captured here is what the daemon dispatches.

// Surface vocab shared by the surface picker and the create-flow.
const SURFACES: Surface[] = ['web', 'image', 'video', 'audio'];

const SURFACE_LABEL_KEY: Record<Surface, keyof Dict> = {
  web: 'newproj.surfaceWeb',
  image: 'newproj.surfaceImage',
  video: 'newproj.surfaceVideo',
  audio: 'newproj.surfaceAudio',
};
const SURFACE_HINT_KEY: Record<Surface, keyof Dict> = {
  web: 'newproj.surfaceWebHint',
  image: 'newproj.surfaceImageHint',
  video: 'newproj.surfaceVideoHint',
  audio: 'newproj.surfaceAudioHint',
};
const SURFACE_ICON: Record<Surface, 'grid' | 'image' | 'video' | 'music'> = {
  web: 'grid',
  image: 'image',
  video: 'video',
  audio: 'music',
};

export function NewProjectPanel({
  skills,
  designSystems,
  defaultDesignSystemId,
  templates,
  onCreate,
  loading = false,
}: Props) {
  const t = useT();
  // Top-level surface — controls which sub-form renders below. We keep
  // it separate from the Web tab state so users can flip between
  // surfaces without losing their per-surface choices.
  const [surface, setSurface] = useState<Surface>('web');
  const [tab, setTab] = useState<CreateTab>('prototype');
  const [name, setName] = useState('');
  // Design-system selection is now an *array* internally so the same
  // component can drive both single-select and multi-select modes without
  // duplicating state. Single-select coerces to length 0/1.
  const [selectedDsIds, setSelectedDsIds] = useState<string[]>([]);
  const [dsMulti, setDsMulti] = useState(false);

  // Per-tab metadata. Tracked independently so switching tabs preserves
  // each tab's pick rather than resetting to defaults.
  const [fidelity, setFidelity] = useState<'wireframe' | 'high-fidelity'>(
    'high-fidelity',
  );
  const [speakerNotes, setSpeakerNotes] = useState(false);
  const [animations, setAnimations] = useState(false);
  const [templateId, setTemplateId] = useState<string | null>(null);

  // Image / Video / Audio metadata. Kept independently so flipping
  // surfaces preserves each surface's last pick instead of resetting.
  const [imageModel, setImageModel] = useState<string>(DEFAULT_IMAGE_MODEL);
  const [imageAspect, setImageAspect] = useState<MediaAspect>('1:1');
  const [imageStyle, setImageStyle] = useState('');
  const [videoModel, setVideoModel] = useState<string>(DEFAULT_VIDEO_MODEL);
  const [videoLength, setVideoLength] = useState<number>(5);
  const [videoAspect, setVideoAspect] = useState<MediaAspect>('16:9');
  const [audioKind, setAudioKind] = useState<AudioKind>('music');
  const [audioModel, setAudioModel] = useState<string>(DEFAULT_AUDIO_MODEL.music);
  const [audioDuration, setAudioDuration] = useState<number>(30);
  const [voice, setVoice] = useState('');

  // When the audio kind flips, reset the model to that kind's default.
  // This keeps users from accidentally creating a "music" project that
  // has `audioModel: minimax-tts` because they last visited speech.
  useEffect(() => {
    setAudioModel(DEFAULT_AUDIO_MODEL[audioKind]);
  }, [audioKind]);

  // When entering the template tab, snap to the first user-saved template
  // if there is one (and we don't already have a valid pick). The template
  // tab no longer offers a built-in fallback — the entire point is to
  // start from a template *the user* created via Share.
  useEffect(() => {
    if (surface !== 'web' || tab !== 'template') return;
    if (templates.length === 0) {
      setTemplateId(null);
      return;
    }
    if (templateId == null || !templates.some((t) => t.id === templateId)) {
      setTemplateId(templates[0]!.id);
    }
  }, [surface, tab, templates, templateId]);

  // The skill the request still routes through — kept so prototype/deck
  // pick a default-rendered skill (so the agent gets the right SKILL.md
  // body) without requiring the user to choose one explicitly. For
  // image / video / audio surfaces we look up a skill that targets that
  // surface; if none ships yet the request still flies (skill_id null),
  // and the agent falls back to its base behavior + project metadata.
  const skillIdForTab = useMemo(() => {
    if (surface === 'image') {
      return pickDefaultSkill(skills, 'image');
    }
    if (surface === 'video') {
      return pickDefaultSkill(skills, 'video');
    }
    if (surface === 'audio') {
      return pickDefaultSkill(skills, 'audio');
    }
    if (tab === 'other') return null;
    if (tab === 'prototype') {
      const list = skills.filter((s) => s.mode === 'prototype');
      return list.find((s) => s.defaultFor.includes('prototype'))?.id
        ?? list[0]?.id
        ?? null;
    }
    if (tab === 'deck') {
      const list = skills.filter((s) => s.mode === 'deck');
      return list.find((s) => s.defaultFor.includes('deck'))?.id
        ?? list[0]?.id
        ?? null;
    }
    return null;
  }, [surface, tab, skills]);

  const canCreate = !loading && (
    surface !== 'web' || tab !== 'template' || templateId != null
  );

  function handleCreate() {
    if (!canCreate) return;
    // Design-system selection only applies to the web surface — the picker
    // is hidden for image/video/audio, so a DS the user picked while on
    // the web surface (and may have forgotten about) must NOT silently
    // attach to a media project and change prompt composition. Force the
    // primary id and inspirations empty for non-web surfaces.
    const primaryDs = surface === 'web' ? selectedDsIds[0] ?? null : null;
    const inspirations = surface === 'web' ? selectedDsIds.slice(1) : [];
    const metadata = buildMetadata({
      surface,
      tab,
      fidelity,
      speakerNotes,
      animations,
      templateId,
      templates,
      inspirationIds: inspirations,
      imageModel,
      imageAspect,
      imageStyle,
      videoModel,
      videoLength,
      videoAspect,
      audioKind,
      audioModel,
      audioDuration,
      voice,
    });
    const fallbackName = surface === 'web'
      ? autoName(tab, t)
      : autoNameForSurface(surface, t);
    onCreate({
      name: name.trim() || fallbackName,
      skillId: skillIdForTab,
      designSystemId: primaryDs,
      metadata,
    });
  }

  // Web surface needs a design-system picker; the media surfaces
  // currently don't bind tokens to a system so we hide it to reduce
  // noise. (When image/video DS surfaces ship, this will swap to a
  // surface-filtered picker variant.)
  const showDesignSystemPicker = surface === 'web';

  // Web surface still uses the four sub-tabs; the media surfaces
  // skip the row entirely because each has a single dedicated form.
  const showWebTabs = surface === 'web';

  return (
    <div className="newproj">
      <SurfacePicker value={surface} onChange={setSurface} />
      {showWebTabs ? (
        <div className="newproj-tabs" role="tablist">
          {(Object.keys(TAB_LABEL_KEYS) as CreateTab[]).map((entry) => (
            <button
              key={entry}
              role="tab"
              aria-selected={tab === entry}
              className={`newproj-tab ${tab === entry ? 'active' : ''}`}
              onClick={() => setTab(entry)}
            >
              {t(TAB_LABEL_KEYS[entry])}
            </button>
          ))}
        </div>
      ) : null}
      <div className="newproj-body">
        <h3 className="newproj-title">{titleForView(surface, tab, t)}</h3>

        <input
          className="newproj-name"
          placeholder={t('newproj.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {showDesignSystemPicker ? (
          <DesignSystemPicker
            designSystems={designSystems}
            defaultDesignSystemId={defaultDesignSystemId}
            selectedIds={selectedDsIds}
            multi={dsMulti}
            onChangeMulti={setDsMulti}
            onChange={setSelectedDsIds}
            loading={loading}
          />
        ) : null}

        {surface === 'web' && tab === 'prototype' ? (
          <FidelityPicker value={fidelity} onChange={setFidelity} />
        ) : null}

        {surface === 'web' && tab === 'deck' ? (
          <ToggleRow
            label={t('newproj.toggleSpeakerNotes')}
            hint={t('newproj.toggleSpeakerNotesHint')}
            checked={speakerNotes}
            onChange={setSpeakerNotes}
          />
        ) : null}

        {surface === 'web' && tab === 'template' ? (
          <>
            <TemplatePicker
              templates={templates}
              value={templateId}
              onChange={setTemplateId}
            />
            <ToggleRow
              label={t('newproj.toggleAnimations')}
              hint={t('newproj.toggleAnimationsHint')}
              checked={animations}
              onChange={setAnimations}
            />
          </>
        ) : null}

        {surface === 'image' ? (
          <ImageForm
            model={imageModel}
            onChangeModel={setImageModel}
            aspect={imageAspect}
            onChangeAspect={setImageAspect}
            style={imageStyle}
            onChangeStyle={setImageStyle}
          />
        ) : null}

        {surface === 'video' ? (
          <VideoForm
            model={videoModel}
            onChangeModel={setVideoModel}
            length={videoLength}
            onChangeLength={setVideoLength}
            aspect={videoAspect}
            onChangeAspect={setVideoAspect}
          />
        ) : null}

        {surface === 'audio' ? (
          <AudioForm
            kind={audioKind}
            onChangeKind={setAudioKind}
            model={audioModel}
            onChangeModel={setAudioModel}
            duration={audioDuration}
            onChangeDuration={setAudioDuration}
            voice={voice}
            onChangeVoice={setVoice}
          />
        ) : null}

        <button
          className="primary newproj-create"
          onClick={handleCreate}
          disabled={!canCreate}
          title={
            surface === 'web' && tab === 'template' && templateId == null
              ? t('newproj.createDisabledTitle')
              : undefined
          }
        >
          <Icon name="plus" size={13} />
          <span>
            {surface === 'web' && tab === 'template'
              ? t('newproj.createFromTemplate')
              : t('newproj.create')}
          </span>
        </button>
      </div>
      <div className="newproj-footer">{t('newproj.privacyFooter')}</div>
    </div>
  );
}

function pickDefaultSkill(
  skills: SkillSummary[],
  surface: Surface,
): string | null {
  // Prefer a skill that explicitly declares `od.surface: <surface>` AND
  // matches the corresponding mode. Fall back to mode-only match so even
  // legacy skills authored without `surface` still get picked up.
  const surfaceMatch = skills.find(
    (s) => s.surface === surface && s.mode === surface,
  );
  if (surfaceMatch) return surfaceMatch.id;
  const modeMatch = skills.find((s) => s.mode === surface);
  if (modeMatch) return modeMatch.id;
  return null;
}

function SurfacePicker({
  value,
  onChange,
}: {
  value: Surface;
  onChange: (s: Surface) => void;
}) {
  const t = useT();
  return (
    <div className="newproj-surfaces" role="tablist" aria-label={t('newproj.surfaceLabel')}>
      {SURFACES.map((s) => (
        <button
          key={s}
          type="button"
          role="tab"
          aria-selected={value === s}
          className={`newproj-surface${value === s ? ' active' : ''}`}
          onClick={() => onChange(s)}
        >
          <Icon name={SURFACE_ICON[s]} size={15} />
          <span className="newproj-surface-label">{t(SURFACE_LABEL_KEY[s])}</span>
          <span className="newproj-surface-hint">{t(SURFACE_HINT_KEY[s])}</span>
        </button>
      ))}
    </div>
  );
}

function ImageForm({
  model,
  onChangeModel,
  aspect,
  onChangeAspect,
  style,
  onChangeStyle,
}: {
  model: string;
  onChangeModel: (id: string) => void;
  aspect: MediaAspect;
  onChangeAspect: (a: MediaAspect) => void;
  style: string;
  onChangeStyle: (s: string) => void;
}) {
  const t = useT();
  return (
    <>
      <ModelPicker
        value={model}
        onChange={onChangeModel}
        options={IMAGE_MODELS}
      />
      <AspectPicker
        value={aspect}
        onChange={onChangeAspect}
        options={['1:1', '16:9', '9:16', '4:3', '3:4']}
      />
      <div className="newproj-section">
        <label className="newproj-label">{t('newproj.imageStyleLabel')}</label>
        <textarea
          className="newproj-textarea"
          rows={3}
          placeholder={t('newproj.imageStylePlaceholder')}
          value={style}
          onChange={(e) => onChangeStyle(e.target.value)}
        />
      </div>
    </>
  );
}

function VideoForm({
  model,
  onChangeModel,
  length,
  onChangeLength,
  aspect,
  onChangeAspect,
}: {
  model: string;
  onChangeModel: (id: string) => void;
  length: number;
  onChangeLength: (n: number) => void;
  aspect: MediaAspect;
  onChangeAspect: (a: MediaAspect) => void;
}) {
  const t = useT();
  const lengths = [3, 5, 10];
  return (
    <>
      <ModelPicker value={model} onChange={onChangeModel} options={VIDEO_MODELS} />
      <div className="newproj-section">
        <label className="newproj-label">{t('newproj.videoLengthLabel')}</label>
        <div className="pill-grid">
          {lengths.map((s) => (
            <button
              key={s}
              type="button"
              className={`pill-grid-btn${length === s ? ' active' : ''}`}
              onClick={() => onChangeLength(s)}
              aria-pressed={length === s}
            >
              {t('newproj.videoLengthSeconds', { n: s })}
            </button>
          ))}
        </div>
      </div>
      <AspectPicker
        value={aspect}
        onChange={onChangeAspect}
        options={['16:9', '9:16', '1:1']}
      />
    </>
  );
}

function AudioForm({
  kind,
  onChangeKind,
  model,
  onChangeModel,
  duration,
  onChangeDuration,
  voice,
  onChangeVoice,
}: {
  kind: AudioKind;
  onChangeKind: (k: AudioKind) => void;
  model: string;
  onChangeModel: (id: string) => void;
  duration: number;
  onChangeDuration: (n: number) => void;
  voice: string;
  onChangeVoice: (v: string) => void;
}) {
  const t = useT();
  const kinds: { id: AudioKind; labelKey: keyof Dict }[] = [
    { id: 'music', labelKey: 'newproj.audioKindMusic' },
    { id: 'speech', labelKey: 'newproj.audioKindSpeech' },
    { id: 'sfx', labelKey: 'newproj.audioKindSfx' },
  ];
  // Music tracks are usually 30s-2min; speech / sfx work in shorter
  // chunks. We expose three buckets per kind so users don't have to
  // free-form-input a number.
  const durations = kind === 'music' ? [30, 60, 120] : [10, 30, 60];
  return (
    <>
      <div className="newproj-section">
        <label className="newproj-label">{t('newproj.audioKindLabel')}</label>
        <div className="pill-grid">
          {kinds.map((k) => (
            <button
              key={k.id}
              type="button"
              className={`pill-grid-btn${kind === k.id ? ' active' : ''}`}
              onClick={() => onChangeKind(k.id)}
              aria-pressed={kind === k.id}
            >
              {t(k.labelKey)}
            </button>
          ))}
        </div>
      </div>
      <ModelPicker
        value={model}
        onChange={onChangeModel}
        options={AUDIO_MODELS_BY_KIND[kind]}
      />
      <div className="newproj-section">
        <label className="newproj-label">{t('newproj.audioDurationLabel')}</label>
        <div className="pill-grid">
          {durations.map((s) => (
            <button
              key={s}
              type="button"
              className={`pill-grid-btn${duration === s ? ' active' : ''}`}
              onClick={() => onChangeDuration(s)}
              aria-pressed={duration === s}
            >
              {t('newproj.audioDurationSeconds', { n: s })}
            </button>
          ))}
        </div>
      </div>
      {kind === 'speech' ? (
        <div className="newproj-section">
          <label className="newproj-label">{t('newproj.voiceLabel')}</label>
          <textarea
            className="newproj-textarea"
            rows={2}
            placeholder={t('newproj.voicePlaceholder')}
            value={voice}
            onChange={(e) => onChangeVoice(e.target.value)}
          />
        </div>
      ) : null}
    </>
  );
}

function ModelPicker({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (id: string) => void;
  options: { id: string; label: string; hint: string }[];
}) {
  const t = useT();
  return (
    <div className="newproj-section">
      <label className="newproj-label">{t('newproj.modelLabel')}</label>
      <div className="model-grid">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`model-card${value === o.id ? ' active' : ''}`}
            onClick={() => onChange(o.id)}
            aria-pressed={value === o.id}
          >
            <span className="model-card-name">{o.label}</span>
            <span className="model-card-hint">{o.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AspectPicker({
  value,
  onChange,
  options,
}: {
  value: MediaAspect;
  onChange: (a: MediaAspect) => void;
  options: MediaAspect[];
}) {
  const t = useT();
  const labelKeyFor: Record<MediaAspect, keyof Dict> = {
    '1:1': 'newproj.aspectSquare',
    '16:9': 'newproj.aspectLandscape',
    '9:16': 'newproj.aspectPortrait',
    '4:3': 'newproj.aspect43',
    '3:4': 'newproj.aspect34',
  };
  return (
    <div className="newproj-section">
      <label className="newproj-label">{t('newproj.aspectLabel')}</label>
      <div className="aspect-grid">
        {options.map((a) => (
          <button
            key={a}
            type="button"
            className={`aspect-card${value === a ? ' active' : ''}`}
            onClick={() => onChange(a)}
            aria-pressed={value === a}
          >
            <span className={`aspect-thumb aspect-thumb-${a.replace(':', 'x')}`} aria-hidden />
            <span className="aspect-label">{t(labelKeyFor[a])}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function FidelityPicker({
  value,
  onChange,
}: {
  value: 'wireframe' | 'high-fidelity';
  onChange: (v: 'wireframe' | 'high-fidelity') => void;
}) {
  const t = useT();
  return (
    <div className="newproj-section">
      <label className="newproj-label">{t('newproj.fidelityLabel')}</label>
      <div className="fidelity-grid">
        <FidelityCard
          active={value === 'wireframe'}
          onClick={() => onChange('wireframe')}
          label={t('newproj.fidelityWireframe')}
          variant="wireframe"
        />
        <FidelityCard
          active={value === 'high-fidelity'}
          onClick={() => onChange('high-fidelity')}
          label={t('newproj.fidelityHigh')}
          variant="high-fidelity"
        />
      </div>
    </div>
  );
}

function FidelityCard({
  active,
  onClick,
  label,
  variant,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  variant: 'wireframe' | 'high-fidelity';
}) {
  return (
    <button
      type="button"
      className={`fidelity-card${active ? ' active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className={`fidelity-thumb fidelity-thumb-${variant}`} aria-hidden>
        {variant === 'wireframe' ? <WireframeArt /> : <HighFidelityArt />}
      </span>
      <span className="fidelity-label">{label}</span>
    </button>
  );
}

function WireframeArt() {
  return (
    <svg viewBox="0 0 120 70" width="100%" height="100%" aria-hidden>
      <rect x="6" y="8" width="46" height="6" rx="2" fill="#d8d4cb" />
      <rect x="6" y="20" width="34" height="4" rx="2" fill="#ebe8e1" />
      <rect x="6" y="28" width="38" height="4" rx="2" fill="#ebe8e1" />
      <rect x="6" y="36" width="30" height="4" rx="2" fill="#ebe8e1" />
      <circle cx="22" cy="56" r="6" fill="none" stroke="#d8d4cb" strokeWidth="1.4" />
      <rect x="64" y="8" width="50" height="54" rx="3" fill="none" stroke="#d8d4cb" strokeWidth="1.4" />
      <rect x="70" y="14" width="38" height="4" rx="2" fill="#ebe8e1" />
      <rect x="70" y="22" width="32" height="4" rx="2" fill="#ebe8e1" />
      <rect x="70" y="30" width="38" height="4" rx="2" fill="#ebe8e1" />
    </svg>
  );
}

function HighFidelityArt() {
  return (
    <svg viewBox="0 0 120 70" width="100%" height="100%" aria-hidden>
      <rect x="6" y="8" width="34" height="6" rx="2" fill="#1a1916" />
      <rect x="6" y="20" width="46" height="4" rx="2" fill="#74716b" />
      <rect x="6" y="28" width="42" height="4" rx="2" fill="#b3b0a8" />
      <rect x="6" y="40" width="22" height="9" rx="2" fill="#c96442" />
      <rect x="64" y="8" width="50" height="54" rx="4" fill="#fbeee5" />
      <rect x="70" y="14" width="38" height="4" rx="2" fill="#c96442" />
      <rect x="70" y="22" width="32" height="3" rx="1.5" fill="#74716b" />
      <rect x="70" y="29" width="36" height="3" rx="1.5" fill="#b3b0a8" />
      <rect x="70" y="36" width="20" height="6" rx="2" fill="#c96442" />
    </svg>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`toggle-row${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
    >
      <div className="toggle-row-text">
        <span className="toggle-row-label">{label}</span>
        {hint ? <span className="toggle-row-hint">{hint}</span> : null}
      </div>
      <span className="toggle-row-switch" aria-hidden />
    </button>
  );
}

function TemplatePicker({
  templates,
  value,
  onChange,
}: {
  templates: ProjectTemplate[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const t = useT();
  return (
    <div className="newproj-section">
      <label className="newproj-label">{t('newproj.templateLabel')}</label>
      {templates.length === 0 ? (
        <div className="template-howto">
          <span className="template-howto-title">
            {t('newproj.noTemplatesTitle')}
          </span>
          <span className="template-howto-body">
            {t('newproj.noTemplatesBody')}
          </span>
        </div>
      ) : (
        <div className="template-list">
          {templates.map((tpl) => {
            const fallbackDesc = `${t('newproj.savedTemplate')} · ${tpl.files.length} ${
              tpl.files.length === 1
                ? t('newproj.fileSingular')
                : t('newproj.filePlural')
            }`;
            return (
              <TemplateOption
                key={tpl.id}
                active={value === tpl.id}
                onClick={() => onChange(tpl.id)}
                name={tpl.name}
                description={tpl.description ?? fallbackDesc}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function TemplateOption({
  active,
  onClick,
  name,
  description,
}: {
  active: boolean;
  onClick: () => void;
  name: string;
  description: string;
}) {
  return (
    <button
      type="button"
      className={`template-option${active ? ' active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className={`template-radio${active ? ' active' : ''}`} aria-hidden />
      <span className="template-option-text">
        <span className="template-option-name">{name}</span>
        <span className="template-option-desc">{description}</span>
      </span>
    </button>
  );
}

/* ============================================================
   Design system picker — custom popover (replaces native <select>).
   - Single-select by default. Toggle in the popover header switches to
     multi-select, which lets users blend up to a few inspirations
     (first pick is the primary; the rest go into metadata).
   - Trigger card mirrors the claude.ai/design treatment: a tiny brand
     swatch strip + title + "Default" subtitle + chevron.
   ============================================================ */
function DesignSystemPicker({
  designSystems,
  defaultDesignSystemId,
  selectedIds,
  multi,
  onChange,
  onChangeMulti,
  loading,
}: {
  designSystems: DesignSystemSummary[];
  defaultDesignSystemId: string | null;
  selectedIds: string[];
  multi: boolean;
  onChange: (ids: string[]) => void;
  onChangeMulti: (v: boolean) => void;
  loading: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const byId = useMemo(() => {
    const map = new Map<string, DesignSystemSummary>();
    for (const d of designSystems) map.set(d.id, d);
    return map;
  }, [designSystems]);

  // Sort: selected first (in pick order), then default DS, then alpha
  // by category then title. Keeps the popover scannable while honoring
  // the user's existing picks.
  const ordered = useMemo(() => {
    const picked = selectedIds
      .map((id) => byId.get(id))
      .filter((d): d is DesignSystemSummary => Boolean(d));
    const pickedSet = new Set(picked.map((d) => d.id));
    const rest = designSystems
      .filter((d) => !pickedSet.has(d.id))
      .sort((a, b) => {
        if (a.id === defaultDesignSystemId) return -1;
        if (b.id === defaultDesignSystemId) return 1;
        const ca = a.category || 'Other';
        const cb = b.category || 'Other';
        if (ca !== cb) return ca.localeCompare(cb);
        return a.title.localeCompare(b.title);
      });
    return [...picked, ...rest];
  }, [designSystems, byId, selectedIds, defaultDesignSystemId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((d) => {
      return (
        d.title.toLowerCase().includes(q) ||
        (d.summary || '').toLowerCase().includes(q) ||
        (d.category || '').toLowerCase().includes(q)
      );
    });
  }, [ordered, query]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    // Defer listener registration by a tick so the very click that opened
    // the popover doesn't get re-interpreted as an outside-click on the
    // mousedown that follows in the same event cycle (StrictMode also
    // double-invokes the effect, which can race the same event).
    const t = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle(id: string) {
    if (multi) {
      // Multi-select: tapping toggles membership; the *first* id in the
      // array is treated as the primary across the rest of the app.
      const has = selectedIds.includes(id);
      if (has) {
        onChange(selectedIds.filter((x) => x !== id));
      } else {
        onChange([...selectedIds, id]);
      }
    } else {
      onChange([id]);
      setOpen(false);
    }
  }

  function clearAll() {
    onChange([]);
    if (!multi) setOpen(false);
  }

  const primaryId = selectedIds[0] ?? null;
  const primary = primaryId ? byId.get(primaryId) ?? null : null;
  const extraCount = Math.max(0, selectedIds.length - 1);
  const isDefault = !!primary && primary.id === defaultDesignSystemId;

  if (loading && designSystems.length === 0) {
    return (
      <div className="newproj-section">
        <label className="newproj-label">{t('newproj.designSystem')}</label>
        <Skeleton height={56} width="100%" radius={8} />
      </div>
    );
  }

  return (
    <div className="newproj-section ds-picker" ref={wrapRef}>
      <label className="newproj-label">{t('newproj.designSystem')}</label>
      <button
        type="button"
        className={`ds-picker-trigger${open ? ' open' : ''}${primary ? '' : ' empty'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <DesignSystemAvatar system={primary} extraCount={extraCount} />
        <span className="ds-picker-meta">
          <span className="ds-picker-title">
            {primary ? primary.title : t('newproj.dsNoneFreeform')}
            {extraCount > 0 ? (
              <span className="ds-picker-extra-pill">+{extraCount}</span>
            ) : null}
          </span>
          <span className="ds-picker-sub">
            {primary
              ? isDefault
                ? t('common.default')
                : primary.category || t('newproj.dsCategoryFallback')
              : t('newproj.dsNoneSubtitleEmpty')}
          </span>
        </span>
        <Icon
          name="chevron-down"
          size={14}
          className="ds-picker-chevron"
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
        />
      </button>
      {open ? (
        <div className="ds-picker-popover" role="listbox">
          <div className="ds-picker-head">
            <input
              ref={searchRef}
              className="ds-picker-search"
              placeholder={t('newproj.dsSearch')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div
              className="ds-picker-mode"
              role="tablist"
              aria-label={t('newproj.dsModeAria')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={!multi}
                className={`ds-picker-mode-btn${!multi ? ' active' : ''}`}
                onClick={() => {
                  onChangeMulti(false);
                  if (selectedIds.length > 1) onChange(selectedIds.slice(0, 1));
                }}
              >
                {t('newproj.dsModeSingle')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={multi}
                className={`ds-picker-mode-btn${multi ? ' active' : ''}`}
                onClick={() => onChangeMulti(true)}
              >
                {t('newproj.dsModeMulti')}
              </button>
            </div>
          </div>
          <div className="ds-picker-list">
            <DsPickerItem
              active={selectedIds.length === 0}
              multi={multi}
              onClick={clearAll}
              avatar={<NoneAvatar />}
              title={t('newproj.dsNoneTitle')}
              subtitle={t('newproj.dsNoneSub')}
            />
            {filtered.length === 0 ? (
              <div className="ds-picker-empty">
                {t('newproj.dsEmpty', { query })}
              </div>
            ) : (
              filtered.map((d) => {
                const active = selectedIds.includes(d.id);
                const order = active ? selectedIds.indexOf(d.id) : -1;
                return (
                  <DsPickerItem
                    key={d.id}
                    active={active}
                    multi={multi}
                    order={order}
                    onClick={() => toggle(d.id)}
                    avatar={<DesignSystemAvatar system={d} />}
                    title={d.title}
                    badge={
                      d.id === defaultDesignSystemId
                        ? t('newproj.dsBadgeDefault')
                        : undefined
                    }
                    subtitle={d.summary || d.category || ''}
                  />
                );
              })
            )}
          </div>
          {multi && selectedIds.length > 1 ? (
            <div className="ds-picker-foot">
              <span className="ds-picker-foot-text">
                <strong>{primary?.title ?? t('newproj.dsPrimaryFallback')}</strong>{' '}
                {extraCount === 1
                  ? t('newproj.dsFootSingular')
                  : t('newproj.dsFootPlural')}
              </span>
              <button
                type="button"
                className="ds-picker-clear"
                onClick={clearAll}
              >
                {t('newproj.dsFootClear')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DsPickerItem({
  active,
  multi,
  order,
  onClick,
  avatar,
  title,
  subtitle,
  badge,
}: {
  active: boolean;
  multi: boolean;
  order?: number;
  onClick: () => void;
  avatar: React.ReactNode;
  title: string;
  subtitle: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={`ds-picker-item${active ? ' active' : ''}`}
      onClick={onClick}
    >
      <span className="ds-picker-item-avatar">{avatar}</span>
      <span className="ds-picker-item-text">
        <span className="ds-picker-item-title">
          {title}
          {badge ? <span className="ds-picker-item-badge">{badge}</span> : null}
        </span>
        <span className="ds-picker-item-sub">{subtitle}</span>
      </span>
      <span
        className={`ds-picker-mark ${multi ? 'check' : 'radio'}${active ? ' active' : ''}`}
        aria-hidden
      >
        {multi ? (
          active ? (order != null && order >= 0 ? order + 1 : '✓') : ''
        ) : null}
      </span>
    </button>
  );
}

function DesignSystemAvatar({
  system,
  extraCount = 0,
}: {
  system: DesignSystemSummary | null;
  extraCount?: number;
}) {
  if (!system) return <NoneAvatar />;
  const swatches = system.swatches && system.swatches.length > 0
    ? system.swatches.slice(0, 4)
    : fallbackSwatches(system.title);
  return (
    <span className="ds-avatar" aria-hidden>
      <span className="ds-avatar-grid">
        {swatches.map((c, i) => (
          <span key={i} className="ds-avatar-cell" style={{ background: c }} />
        ))}
      </span>
      {extraCount > 0 ? (
        <span className="ds-avatar-stack">+{extraCount}</span>
      ) : null}
    </span>
  );
}

function NoneAvatar() {
  return (
    <span className="ds-avatar ds-avatar-none" aria-hidden>
      <svg viewBox="0 0 24 24" width="16" height="16">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <line x1="6" y1="18" x2="18" y2="6" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </span>
  );
}

// Deterministic fallback swatches for design systems whose DESIGN.md doesn't
// expose its tokens via the bold-and-hex format. Keeps the avatar visually
// distinct per-system without extra metadata fetches.
function fallbackSwatches(seed: string): string[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const base = h % 360;
  return [
    `hsl(${base}, 18%, 96%)`,
    `hsl(${(base + 90) % 360}, 22%, 78%)`,
    `hsl(${(base + 180) % 360}, 30%, 32%)`,
    `hsl(${(base + 30) % 360}, 70%, 52%)`,
  ];
}

function buildMetadata(input: {
  surface: Surface;
  tab: CreateTab;
  fidelity: 'wireframe' | 'high-fidelity';
  speakerNotes: boolean;
  animations: boolean;
  templateId: string | null;
  templates: ProjectTemplate[];
  inspirationIds: string[];
  imageModel: string;
  imageAspect: MediaAspect;
  imageStyle: string;
  videoModel: string;
  videoLength: number;
  videoAspect: MediaAspect;
  audioKind: AudioKind;
  audioModel: string;
  audioDuration: number;
  voice: string;
}): ProjectMetadata {
  const inspirations = input.inspirationIds.length > 0
    ? { inspirationDesignSystemIds: input.inspirationIds }
    : {};

  if (input.surface === 'image') {
    return {
      kind: 'image',
      imageModel: input.imageModel,
      imageAspect: input.imageAspect,
      imageStyle: input.imageStyle.trim() || undefined,
      ...inspirations,
    };
  }
  if (input.surface === 'video') {
    return {
      kind: 'video',
      videoModel: input.videoModel,
      videoLength: input.videoLength,
      videoAspect: input.videoAspect,
      ...inspirations,
    };
  }
  if (input.surface === 'audio') {
    return {
      kind: 'audio',
      audioKind: input.audioKind,
      audioModel: input.audioModel,
      audioDuration: input.audioDuration,
      voice:
        input.audioKind === 'speech' && input.voice.trim()
          ? input.voice.trim()
          : undefined,
      ...inspirations,
    };
  }

  const kind: ProjectKind = input.tab;
  if (input.tab === 'prototype') {
    return { kind, fidelity: input.fidelity, ...inspirations };
  }
  if (input.tab === 'deck') {
    return { kind, speakerNotes: input.speakerNotes, ...inspirations };
  }
  if (input.tab === 'template') {
    if (input.templateId == null) {
      return { kind, animations: input.animations, ...inspirations };
    }
    const tpl = input.templates.find((x) => x.id === input.templateId);
    // The fallback label is consumed by the agent prompt rather than the
    // UI, so we keep it in English to match the rest of the prompt corpus.
    return {
      kind,
      animations: input.animations,
      templateId: input.templateId,
      templateLabel: tpl?.name ?? 'Saved template',
      ...inspirations,
    };
  }
  return { kind: 'other', ...inspirations };
}

function titleForView(surface: Surface, tab: CreateTab, t: TranslateFn): string {
  if (surface === 'image') return t('newproj.titleImage');
  if (surface === 'video') return t('newproj.titleVideo');
  if (surface === 'audio') return t('newproj.titleAudio');
  switch (tab) {
    case 'prototype':
      return t('newproj.titlePrototype');
    case 'deck':
      return t('newproj.titleDeck');
    case 'template':
      return t('newproj.titleTemplate');
    case 'other':
      return t('newproj.titleOther');
  }
}

function autoName(tab: CreateTab, t: TranslateFn): string {
  const stamp = new Date().toLocaleDateString();
  return `${t(TAB_LABEL_KEYS[tab])} · ${stamp}`;
}

function autoNameForSurface(surface: Surface, t: TranslateFn): string {
  const stamp = new Date().toLocaleDateString();
  return `${t(SURFACE_LABEL_KEY[surface])} · ${stamp}`;
}
