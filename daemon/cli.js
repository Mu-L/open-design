#!/usr/bin/env node
import { startServer } from './server.js';

const argv = process.argv.slice(2);

// ---- Subcommand router ----------------------------------------------------
//
// `od` is two CLIs glued together:
//   - default mode: starts the daemon + opens the web UI.
//   - `od media …`: a thin client that POSTs to the running daemon. This
//     is what the code agent invokes from inside a chat to actually
//     produce image / video / audio bytes (the unifying contract).
//
// We dispatch on the first positional argument so flags like --port keep
// working unchanged. Subcommand routing is keyword-based; flags are
// parsed inside each handler.

// Flags accepted by `od media generate`. Whitelisted so a hallucinated
// `--lenght 5` from the LLM fails fast instead of silently no-op'ing
// while we route a bogus body to the daemon.
//
// Hoisted to the top of the module *before* the subcommand dispatch
// below: top-level `await SUBCOMMAND_MAP[first](rest)` runs runMedia
// synchronously during module evaluation, and runMedia references these
// `const` Sets — leaving them at the bottom of the file would hit the
// TDZ ("Cannot access 'MEDIA_GENERATE_STRING_FLAGS' before
// initialization") and crash every `od media …` invocation.
const MEDIA_GENERATE_STRING_FLAGS = new Set([
  'project',
  'surface',
  'model',
  'prompt',
  'output',
  'aspect',
  'length',
  'duration',
  'voice',
  'audio-kind',
  'daemon-url',
]);
const MEDIA_GENERATE_BOOLEAN_FLAGS = new Set([
  'help',
  'h',
]);

const SUBCOMMAND_MAP = {
  media: runMedia,
};

const first = argv.find((a) => !a.startsWith('-'));
if (first && SUBCOMMAND_MAP[first]) {
  const idx = argv.indexOf(first);
  const rest = [...argv.slice(0, idx), ...argv.slice(idx + 1)];
  await SUBCOMMAND_MAP[first](rest);
  process.exit(0);
}

// Default: daemon mode.
let port = Number(process.env.OD_PORT) || 7456;
let open = true;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-p' || a === '--port') {
    port = Number(argv[++i]);
  } else if (a === '--no-open') {
    open = false;
  } else if (a === '-h' || a === '--help') {
    printRootHelp();
    process.exit(0);
  }
}

startServer({ port }).then(url => {
  console.log(`[od] listening on ${url}`);
  if (open) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    import('node:child_process').then(({ spawn }) => {
      spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
    });
  }
});

function printRootHelp() {
  console.log(`Usage:
  od [--port <n>] [--no-open]
      Start the local daemon and open the web UI.

  od media generate --surface <image|video|audio> --model <id> [opts]
      Generate a media artifact and write it into the active project.
      Designed to be invoked by a code agent — picks up OD_DAEMON_URL
      and OD_PROJECT_ID from the env that the daemon injected on spawn.

What the daemon does:
  * scans PATH for installed code-agent CLIs (claude, codex, gemini, opencode, cursor-agent, ...)
  * serves the chat UI at http://localhost:<port>
  * proxies messages (text + images) to the selected agent via child-process spawn
  * exposes /api/projects/:id/media/generate — the unified image/video/audio
    dispatcher that the agent calls via \`od media generate\`.`);
}

// ---------------------------------------------------------------------------
// Subcommand: od media …
// ---------------------------------------------------------------------------

async function runMedia(args) {
  const sub = args.find((a) => !a.startsWith('-')) || '';
  if (sub === 'help' || sub === '-h' || sub === '--help' || sub === '') {
    printMediaHelp();
    return;
  }
  if (sub !== 'generate') {
    console.error(`unknown subcommand: od media ${sub}`);
    printMediaHelp();
    process.exit(1);
  }

  const idx = args.indexOf(sub);
  let flags;
  try {
    flags = parseFlags([...args.slice(0, idx), ...args.slice(idx + 1)], {
      string: MEDIA_GENERATE_STRING_FLAGS,
      boolean: MEDIA_GENERATE_BOOLEAN_FLAGS,
    });
  } catch (err) {
    console.error(err.message);
    printMediaHelp();
    process.exit(2);
  }

  const daemonUrl = flags['daemon-url'] || process.env.OD_DAEMON_URL || 'http://127.0.0.1:7456';
  const projectId = flags.project || process.env.OD_PROJECT_ID;
  if (!projectId) {
    console.error(
      'project id required. Pass --project <id> or set OD_PROJECT_ID. The daemon injects this when it spawns the code agent.',
    );
    process.exit(2);
  }

  const surface = flags.surface;
  if (!surface || !['image', 'video', 'audio'].includes(surface)) {
    console.error('--surface must be one of: image | video | audio');
    process.exit(2);
  }
  if (!flags.model) {
    console.error('--model required (see http://<daemon>/api/media/models)');
    process.exit(2);
  }

  const body = {
    surface,
    model: flags.model,
    // Prompts remain opaque text all the way through the daemon and must
    // never be shell-interpolated by downstream providers. Every current
    // renderer uses fetch + JSON bodies, not exec/spawn.
    prompt: flags.prompt,
    output: flags.output,
    aspect: flags.aspect,
    voice: flags.voice,
    audioKind: flags['audio-kind'],
  };
  if (flags.length != null) body.length = Number(flags.length);
  if (flags.duration != null) body.duration = Number(flags.duration);

  const url = `${daemonUrl.replace(/\/$/, '')}/api/projects/${encodeURIComponent(projectId)}/media/generate`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // undici's top-level message for connect failures is the unhelpful
    // `fetch failed` — the actual reason lives on `err.cause`. Drill into
    // it so the agent (and any human reading the log) sees the real
    // condition: `ECONNREFUSED` if the port is dead, `EPERM` /
    // `ENETUNREACH` if a sandbox blocked the dial (typical when running
    // under Codex `workspace-write` without `network_access=true`),
    // `ENOTFOUND` for DNS, etc.
    const cause = err && typeof err === 'object' ? err.cause : null;
    const code =
      cause && typeof cause === 'object' && typeof cause.code === 'string'
        ? cause.code
        : null;
    const causeMsg =
      cause && typeof cause === 'object' && typeof cause.message === 'string'
        ? cause.message
        : '';
    let detail = err && err.message ? err.message : String(err);
    if (code) detail = `${code}${causeMsg ? ` — ${causeMsg}` : ''}`;
    else if (causeMsg) detail = causeMsg;
    console.error(`failed to reach daemon at ${daemonUrl}: ${detail}`);
    if (code === 'EPERM' || code === 'ENETUNREACH') {
      console.error(
        'hint: outbound connect was denied by a sandbox. If you launched ' +
          'this command from a code agent, check the agent\'s sandbox / ' +
          'network policy. The OD daemon itself is unaffected — it can be ' +
          'reached from a regular shell.',
      );
    }
    process.exit(3);
  }
  const text = await resp.text();
  if (!resp.ok) {
    console.error(`daemon ${resp.status}: ${text}`);
    process.exit(4);
  }
  // The daemon sometimes "succeeds" by writing a stub fallback after the
  // real provider call failed (so the agent's chat loop doesn't dead-end).
  // Inspect the response and shout the failure on stderr so a code agent
  // sees it clearly: stdout stays a single JSON line for parsing, stderr
  // carries the human-readable warning that maps onto a chat warning.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const file = parsed && parsed.file;
  const warnings = file && Array.isArray(file.warnings) ? file.warnings : [];
  for (const warning of warnings) {
    if (typeof warning === 'string' && warning) {
      console.error(`WARN: ${warning}`);
    }
  }
  if (file && file.providerError) {
    const provider = file.providerId || 'provider';
    console.error(
      `WARN: ${provider} call failed — wrote stub fallback (${file.size} bytes) to ${file.name}`,
    );
    console.error(`WARN: reason: ${file.providerError}`);
    console.error(
      'WARN: surface this verbatim to the user. Do NOT claim the stub is the final result.',
    );
  }
  // Print the JSON response as one line so the agent can parse it.
  process.stdout.write(text.trim() + '\n');
  if (file && file.providerError) {
    // Exit non-zero so shells/agents that gate on $? notice. We use 5
    // (distinct from 1-4 above) to mean "daemon ok, provider failed".
    process.exit(5);
  }
}

// Tolerant of two shapes the LLM might emit:
//   --flag value     (space-separated)
//   --flag=value     (equals form, useful when value starts with `--`)
//
// `string`/`boolean` whitelists let us tell the difference between a
// flag whose value happens to begin with `--` (we still consume the next
// token) and a true bare boolean.
function parseFlags(argv, opts = {}) {
  const stringFlags = opts.string instanceof Set ? opts.string : new Set();
  const booleanFlags = opts.boolean instanceof Set ? opts.boolean : new Set();
  const knownFlags = new Set([...stringFlags, ...booleanFlags]);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) {
      // Positional tokens are owned by the caller (subcommand name); the
      // caller strips them before calling parseFlags, so anything here
      // is an unknown stray.
      throw new Error(`unexpected positional argument: ${a}`);
    }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (knownFlags.size > 0 && !knownFlags.has(key)) {
      throw new Error(
        `unknown flag: --${key}. Run with --help for the list of accepted flags.`,
      );
    }
    if (eq >= 0) {
      out[key] = a.slice(eq + 1);
      continue;
    }
    if (booleanFlags.has(key)) {
      out[key] = true;
      continue;
    }
    if (stringFlags.has(key)) {
      const next = argv[i + 1];
      if (next == null) {
        throw new Error(`flag --${key} requires a value`);
      }
      // Always consume the next token for a known string flag, even if
      // it begins with `--` (e.g. `--prompt "--minimal style"` after the
      // shell has unquoted it). Otherwise a legitimate prompt that
      // starts with `--` gets dropped and `out.prompt` becomes `true`.
      out[key] = next;
      i++;
      continue;
    }
    // Unknown-but-whitelist-mode-off: legacy behavior — assume next
    // non-flag token is the value, fall back to boolean. Kept so callers
    // that don't pass whitelists still work.
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function printMediaHelp() {
  console.log(`Usage: od media generate --surface <image|video|audio> --model <id> [opts]

Required:
  --surface  image | video | audio
  --model    Model id from /api/media/models (e.g. gpt-image-2, seedance-2, suno-v5).
  --project  Project id. Auto-resolved from OD_PROJECT_ID when invoked by the daemon.

Common options:
  --prompt "<text>"         Generation prompt.
  --output <filename>       File to write under the project. Auto-named if omitted.
  --aspect 1:1|16:9|9:16|4:3|3:4
  --length <seconds>        Video length.
  --duration <seconds>      Audio duration.
  --voice <voice-id>        Speech / TTS voice.
  --audio-kind music|speech|sfx
  --daemon-url http://127.0.0.1:7456

Output: a single line of JSON: {"file": { name, size, kind, mime, ... }}.

Skills should call this and then reference the returned filename in their
artifact / message body. The daemon writes the bytes into the project's
files folder so the FileViewer can preview them immediately.`);
}
