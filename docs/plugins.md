# Docent plugins

A Docent plugin is **a manifest and a program**. The desktop app discovers the
manifest in its plugins folder, starts the program, checks that it is up,
proxies it on Docent's own loopback origin, and stops it on quit. The page
never loads plugin code — the canvas, the overlay, and the scene stay exactly
as bounded as they are — so a plugin can be written in any language that can
answer HTTP on `127.0.0.1`.

What a plugin can *do* is fixed by the **contracts** it declares. A contract is
a small HTTP shape with a name and a major version; this page is the public
surface for both the manifest and the contracts, and they change only by a
recorded decision in Docent's constitution (A10, D50–D53).

Plugins are a **desktop** capability. The self-host deployment does not host
them in v1; the routes are origin-relative so it can follow later without a
change to any plugin.

## Where plugins live

| | Plugins folder |
|---|---|
| macOS | `~/Library/Application Support/io.github.happyren.docent/plugins/<name>/` |
| Linux | `~/.config/io.github.happyren.docent/plugins/<name>/` |
| Windows | `%APPDATA%\io.github.happyren.docent\plugins\<name>\` |

One folder per plugin, named exactly as the manifest's `name`, holding
`docent-plugin.json`. The folder is the process's working directory, and
`plugin.log` beside the manifest is where its stdout and stderr go.
**View → Plugins…** lists what was found — name, version, contracts, license,
status — and switches each one on or off; the choice is remembered in
`plugins.json` next to the folder and acted on at the next launch.

## The manifest

```json
{
  "name": "pocket-tts",
  "version": "0.1.0",
  "description": "Spoken narration through Kyutai's Pocket TTS.",
  "contracts": ["speech/1"],
  "homepage": "https://github.com/happyren/docent-pocket-tts",
  "run": {
    "command": "uvx",
    "args": ["pocket-tts", "serve", "--host", "127.0.0.1", "--port", "{port}"],
    "health": "/"
  },
  "license": { "engine": "MIT", "weights": "CC-BY-4.0" },
  "voices": [{ "id": "alba", "license": "CC BY 4.0" }]
}
```

| Field | Meaning |
|---|---|
| `name` | `^[a-z0-9][a-z0-9-]{0,63}$`; must equal the folder name. Also the route: `/plugins/<name>/…` |
| `version` | Shown as is |
| `description` | One or two sentences for the panel |
| `contracts` | The contracts fulfilled, e.g. `["speech/1"]`. A major Docent does not know is **refused** — the plugin is listed with the reason and cannot be enabled |
| `run` | How to start the provider: `command`, `args` (one of them must contain `{port}`, which Docent replaces with a free loopback port; `DOCENT_PLUGIN_PORT` is set in the environment too), and `health` — a path polled every 500 ms until it answers any HTTP status. There is no deadline while the process lives: a first run may be downloading weights. The process exiting marks the plugin *failed* with its exit status |
| `url` | Instead of `run`: a service you run yourself. **Loopback only** — `http://127.0.0.1:…`, `http://localhost:…`, or `http://[::1]:…`; anything else is refused. An attached service that does not answer within 30 s is marked failed |
| `license` | Free-form — a string or an object — shown verbatim in the panel. Say what the engine, its weights, and its voices are licensed under |
| `voices` | `speech/1` only: the fallback voice list when the provider has no `/voices` route — `[{ "id", "license"?, "description"? }]` |
| `homepage` | A link the panel offers |

Docent stops what it started: on disable and on quit, the process is
terminated (on Unix, its children first). A provider should therefore not
daemonize.

## Contracts

### `speech/1` — spoken narration

The provider turns text into audio. The shape is Pocket TTS's own serving
API, so the reference engine needs no adapter; other engines conform by
matching it.

**`POST /tts`** — `multipart/form-data` with:

| Field | |
|---|---|
| `text` | The words to say. Docent sends plain reading text (arrows already read as "to", markdown stripped) |
| `voice_url` | Optional. A voice id from `/voices` or the manifest's `voices`; absent means the provider's default. (`voice` is accepted as an alias by conforming providers; Docent sends `voice_url`) |

Answers `200` with `Content-Type: audio/wav`, **streamed** (chunked
transfer): a RIFF/WAVE header followed by PCM. Docent decodes as bytes arrive
and starts playing on the first chunk, so the header's size fields may be
placeholders. Accepted encodings: 16-bit or 32-bit integer PCM, or 32-bit
float, any sample rate, mono or stereo (mixed down). A non-2xx status with a
text body is shown to the person as the reason.

**`GET /voices`** — optional. `[{ "id": "alba", "license": "CC BY 4.0", "description": "…" }]`.
Without it, the manifest's `voices` list is used.

**Health** — whatever `run.health` names (`/` for Pocket TTS) must answer once
the model is loaded, not before: Docent treats the first answer as *running*.

How Docent uses it (D52): every narration reaching the person — an agent's
`narrate`, each `tour` step, the author's frame narrative as a presentation
reaches its frame — is spoken through the running `speech/1` provider. Speech
is off until the person enables it (one click, because browsers need one
gesture before audio), cancels when the narration changes, mutes with **M**
during a presentation, and paces tours: a step lasts at least as long as its
speech. An agent's `narrate` call never waits for audio.

## Writing one

1. Make a program that answers a contract on `127.0.0.1:$DOCENT_PLUGIN_PORT`
   (or on the port in its arguments).
2. Write `docent-plugin.json` beside it; name the folder after it.
3. Drop the folder into the plugins folder, open **View → Plugins…**, switch
   it on. *Rescan* picks up a folder added while the app runs.
4. `plugin.log` is your program's output. A refused manifest says why in the
   panel.

The reference plugin is
[happyren/docent-pocket-tts](https://github.com/happyren/docent-pocket-tts) —
a manifest, an installer, and the notices the engine's licenses require.
Copy it.

## What plugins are not

- **Not page code.** There is no way to add UI, hook the adapter, draw on the
  overlay, or touch the scene from a plugin, and there will not be one in this
  form: a webview has no sandbox, and a plugin that reaches Excalidraw is a
  fork by another name.
- **Not a marketplace.** No registry, signing, or auto-update. Installation is
  a folder you put there yourself, on the same single-user trust as the rest
  of the app.
- **Not remote.** Providers answer on loopback only. Narration text is never
  sent off the machine by a plugin.

New kinds of plugin arrive as new contracts — small, typed, documented here —
when Docent adds them.
