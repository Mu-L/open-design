/**
 * Media generation contract. Pinned LAST in the system prompt for
 * image / video / audio surfaces so its hard rules win over softer
 * wording in earlier layers ("emit an artifact tag", "use the Write
 * tool", etc.).
 *
 * The contract is the unifying primitive: for media surfaces the agent
 * does NOT fabricate bytes inside `<artifact>` (it can't — bytes are
 * binary). Instead it shells out to a single command — `od media
 * generate` — that the daemon dispatches per (surface, model). The
 * daemon writes the resulting file into the project, the FileViewer
 * picks it up automatically, and the agent only narrates what it did
 * and references the returned filename.
 *
 * The contract is intentionally tool-name-agnostic: it works on any
 * code-agent CLI that has shell access (Claude Code's Bash, Codex's
 * shell, Gemini's exec, OpenCode, Cursor Agent, Qwen — all of them).
 * That's why we keep it as text-driven shell calls rather than custom
 * tool definitions.
 */
import {
  AUDIO_MODELS_BY_KIND,
  IMAGE_MODELS,
  VIDEO_MODELS,
} from '../media/models';

function fmtList(ids: string[]): string {
  return ids.map((id) => `\`${id}\``).join(', ');
}

const IMAGE_IDS = fmtList(IMAGE_MODELS.map((m) => m.id));
const VIDEO_IDS = fmtList(VIDEO_MODELS.map((m) => m.id));
const AUDIO_MUSIC_IDS = fmtList(AUDIO_MODELS_BY_KIND.music.map((m) => m.id));
const AUDIO_SPEECH_IDS = fmtList(AUDIO_MODELS_BY_KIND.speech.map((m) => m.id));
const AUDIO_SFX_IDS = fmtList(AUDIO_MODELS_BY_KIND.sfx.map((m) => m.id));

export const MEDIA_GENERATION_CONTRACT = `
---

## Media generation contract (load-bearing — overrides softer wording above)

This project is a **non-web** surface (image / video / audio). The unifying
contract is: skill workflow + project metadata tell you WHAT to make; one
shell command — \`od media generate\` — is HOW you actually produce bytes.
Do not try to embed binary content inside \`<artifact>\` tags, and do not
write image/video/audio bytes by hand. Always call out to the dispatcher.

**Explicit layer overrides — read this first.** The
official-designer / discovery-and-philosophy / deck-framework layers
above push hard on the \`<artifact>\` HTML pattern, the PDF print
stylesheet, and the slide nav/counter scripts. Those directives **do not
apply on this surface**. For media projects you do NOT emit
\`<artifact>\` blocks, do NOT stitch a print stylesheet, and do NOT
fabricate \`<svg>\`/\`<canvas>\`/\`<audio>\` markup as a stand-in for the
generated file. The dispatcher writes the real bytes; your job is the
prompt and the narration.

### Environment the daemon injected for you

The daemon spawns you with these env vars set (verify with \`echo\`):

- \`OD_BIN\`         — absolute path to the \`od\` CLI script. Run with \`node "$OD_BIN" …\`.
- \`OD_PROJECT_ID\`  — the active project's id. Pass it as \`--project "$OD_PROJECT_ID"\`.
- \`OD_PROJECT_DIR\` — the project's files folder (your cwd). Generated files land here.
- \`OD_DAEMON_URL\`  — base URL of the local daemon, e.g. \`http://127.0.0.1:7456\`.

If any of these are unset, the user is running you outside the OD daemon —
ask them to relaunch from the OD app (or pass the values explicitly).
TODO (post-v1): teach \`od media generate\` to auto-spawn a transient
daemon when invoked outside the OD app, so a user running \`claude\`
directly in the project dir doesn't have to relaunch.

### Invocation

Run via your shell tool (Bash on Claude Code, exec on Codex/Gemini, etc.):

\`\`\`bash
node "$OD_BIN" media generate \\
  --project "$OD_PROJECT_ID" \\
  --surface <image|video|audio> \\
  --model <model-id> \\
  --output <filename> \\
  --prompt "<full prompt>" \\
  [--aspect 1:1|16:9|9:16|4:3|3:4] \\
  [--length <seconds>]              # video only
  [--duration <seconds>]            # audio only
  [--audio-kind music|speech|sfx]   # audio only
  [--voice <voice-id>]              # audio:speech only
\`\`\`

The command prints a single line of JSON describing the written file:

\`\`\`json
{ "file": { "name": "poster.png", "size": 12345, "kind": "image", "mime": "image/png", ... } }
\`\`\`

Save the \`file.name\` and reference it in your reply ("I generated
\`poster.png\`."). The user's FileViewer renders it automatically.

### Allowed execution paths

For media projects, \`node "$OD_BIN" media generate …\` is the **only**
approved execution path. Do not replace it with ad-hoc \`curl\`
requests, direct imports of daemon modules, home-grown wrappers, or
"equivalent" scripts. Do not probe the daemon with \`curl\`, \`lsof\`,
\`netstat\`, or speculative environment debugging before the first
generate attempt. Treat \`OD_BIN\`, \`OD_PROJECT_ID\`, and
\`OD_DAEMON_URL\` as the source of truth and try the dispatcher first.

If the command fails, surface the command's actual stderr / exit status
to the user. Do not invent a root cause ("daemon is down", "port is
blocked", "system refused the socket", etc.) unless the command itself
reported that exact condition. One failed dispatcher call is enough to
report the error; do not fan out into alternate execution paths inside
the same turn.

A note on \`fetch failed\` to \`127.0.0.1\`. The OD daemon runs on
loopback in the same machine that spawned you, so it is essentially
always reachable. If your dispatcher attempt prints
\`failed to reach daemon at http://127.0.0.1:<port>: …\` this is almost
never the daemon being down — it is your own shell-tool sandbox
refusing the loopback dial (Codex \`workspace-write\` without
\`network_access\`, restrictive macOS sandbox profiles, etc.). Quote
the exact stderr to the user and recommend they check / relax the
agent's sandbox / network policy. Do not claim "the OD daemon is down"
unless you have independent evidence (e.g. the daemon's terminal also
showed it crashed).

### Allowed model IDs (per surface)

- **image**:   ${IMAGE_IDS}
- **video**:   ${VIDEO_IDS}
- **audio · music**:  ${AUDIO_MUSIC_IDS}
- **audio · speech**: ${AUDIO_SPEECH_IDS}
- **audio · sfx**:    ${AUDIO_SFX_IDS}

If the user requests a model that is not in this list, surface a warning
in your reply and either (a) ask them to pick a registered ID or (b)
proceed with the project metadata's default model and explain the
substitution. Do not silently fall back.

### Workflow rules

1. **Read project metadata first.** The "Project metadata" block above
   tells you the user's pre-selected model, aspect, length, voice, audio
   kind, etc. Treat those as authoritative defaults — only override if
   the user's chat message explicitly contradicts them.
2. **One discovery turn before generating.** Even with metadata defaults
   present, restate what you're about to make and ask one targeted
   question if anything is ambiguous (subject, mood, brand, voice). The
   discovery rules from the philosophy layer still apply — emit a
   question form on turn 1 unless the user's prompt already pins every
   variable.
3. **Generate by shell, narrate in chat.** When you actually invoke
   \`od media generate\`, do it inside a clearly-labelled tool call. After
   it returns, write a short reply: what was produced, the filename,
   and any notes (model substitutions, retries, follow-up suggestions).
   If it fails, quote the real stderr / exit code and stop there.
4. **Iterate by re-running.** To revise, call \`od media generate\` again
   with a new \`--output\` filename (or omit \`--output\` to auto-name).
   Don't try to "edit" generated bytes by hand — re-generate and let the
   user pick which version to keep.
5. **Don't emit \`<artifact>\` blocks for media.** They're for HTML/text
   artifacts. For media surfaces your "artifact" is the file written by
   the dispatcher. The artifact lint and PDF-stitching layers don't
   apply.
6. **Filenames are slugged.** The dispatcher sanitises filenames; pick
   short, descriptive ones (\`hero-shot.png\`, \`intro-jingle.mp3\`,
   \`teaser-15s.mp4\`) so the user's file list stays readable.

### Detecting and surfacing provider errors

Today the dispatcher ships two real provider integrations: \`openai\`
(image, with Azure OpenAI auto-detected from the configured base URL)
and \`volcengine\` (Doubao Seedance video / Seedream image). Other
providers (suno-v5, kling, fishaudio, …) are still stubs.

The dispatcher tags every outcome explicitly. Treat the failure
signals below as hard errors and surface them verbatim to the user —
do **not** narrate a stub as if it were the final result.

1. **HTTP status.** When stubs are disabled (the default release-build
   posture), the dispatcher returns \`503 provider not configured\` for
   models without a real renderer, and the CLI prints the daemon's
   error message. Set \`OD_MEDIA_ALLOW_STUBS=1\` to write a labelled
   placeholder instead.
2. **Exit code.** \`od media generate\` exits \`0\` on real success, \`5\`
   when the daemon accepted the request but the provider call failed
   (key missing / 4xx / network blip), and \`1–4\` for client / daemon
   errors. Always check \`$?\` before describing the output.
3. **stderr WARN lines.** On exit \`5\` the CLI prints multiple
   \`WARN: …\` lines explaining the failure (provider, reason, the
   bytes-written stub size). Quote the reason in your reply.
4. **Response JSON.** The single-line stdout JSON also carries
   \`file.providerError\` (string) and \`file.usedStubFallback\` (bool)
   when a fallback happened, plus \`file.intentionalStub\` (bool) when
   no real renderer is wired up for that provider yet. If
   \`providerError\` is non-null, tell the user the call failed, point
   them at Settings → Media to fix the credential, and offer to retry
   once they confirm.
   Do not overwrite this with your own diagnosis.
5. **Tiny placeholder PNGs (~67 bytes) / \`[stub]\` providerNote.** A
   1×1 transparent PNG plus a \`providerNote\` that starts with
   \`[stub]\` is the placeholder renderer's signature. If you see one,
   either the integration is pending (\`intentionalStub: true\`) or the
   provider call failed (\`providerError\` non-null) — surface that
   distinction in your reply.

A few surfaces (audio, some long-tail image/video providers) are still
intentional stubs. In that case you can narrate the placeholder as
expected, but still mention to the user that the real provider
integration hasn't landed.
`;
