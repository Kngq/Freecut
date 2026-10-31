# freecut — Project Handoff

This document is the single source of truth for the project's mission, architecture, and state.
It is written to be self-contained: a new session should be able to start from here with no prior
context.

## Mission

freecut is a **from-scratch, local-first video editor** (Electron + React + TypeScript + Vite)
inspired by CapCut's UX, using its own `.fcproj` JSON project format. The guiding principles:

- **Local and offline-first.** Everything runs on the user's machine. The bundled ffmpeg does all
  media work; optional ML features (captions, background removal) use locally-downloaded models,
  never a cloud API. No telemetry, no network at edit time (only one-time model downloads).
- **Faithful to CapCut's feel** — timeline with filmstrip thumbnails + waveforms, a media bin,
  a preview with transport controls under it, an inspector, effects/transitions, text, and MP4
  export — but a clean, minimal, understandable codebase.
- **Correctness shared between preview and export.** The Canvas-2D live preview and the ffmpeg
  export are driven by the same pure logic (`src/shared/`) so what you see is what you render.

## Tech stack & layout

- **Main process** (`electron/main/`): Node APIs, ffmpeg/ffprobe spawning, model download/run,
  the `freecut-media://` privileged scheme for serving local files to the renderer, all IPC
  handlers (`index.ts`). Marked external in the main vite build: `ffmpeg-static`, `ffprobe-static`,
  `onnxruntime-node`.
- **Preload** (`electron/preload/`): contextBridge `window.api`, thin `ipcRenderer.invoke` wrappers.
- **Renderer** (`src/renderer/`): React UI. Zustand stores in `src/renderer/state/`.
- **Shared** (`src/shared/`): isomorphic, unit-tested pure logic — `types.ts` (data model +
  catalogs + helpers), `ffmpegGraph.ts` (builds the export filter graph), `effects.ts` (effect
  math used by both preview and export), `ipc.ts` (the `FreecutApi` contract).

### Key files
- `src/shared/types.ts` — Project/Track/Clip model; `ProjectCanvas` (width/height/fps/colorSpace);
  catalogs: `EFFECT_CATALOG`, `TRANSITION_CATALOG`, `FONT_CATALOG`, `ASPECT_PRESETS`,
  `SUPPORTED_EXTENSIONS`; helpers `createEmptyProject`, `formatMMSS`, `fontCatalogEntry`,
  `aspectPresetFor`, `fileExtension`.
- `src/renderer/state/projectStore.ts` — the document + transient UI state (selection, playhead,
  isPlaying, pxPerSecond, previewAssetId) and all mutation actions.
- `src/renderer/state/layoutStore.ts` — persisted view prefs: panel sizes, `trackHeight`
  (short/default/tall via `TRACK_HEIGHTS`), `useProxies`.
- `src/renderer/state/toastStore.ts` — non-modal notification stack (`Toasts.tsx`).
- `src/renderer/components/` — `Timeline.tsx`, `Preview.tsx`, `Inspector.tsx`, `MediaBin.tsx`,
  `Toolbar.tsx`, `Home.tsx`, `EffectPreview.tsx`, `CaptionsPanel.tsx`, `BackgroundRemovalButton.tsx`.
- `electron/main/` — `export.ts`, `proxy.ts`, `probe.ts`, `thumbnails.ts`, `waveform.ts`,
  `transcribe.ts` (captions), `background.ts` (bg removal), `mediaProtocol.ts`.

## Current feature state (all implemented & verified)

Core (pre-existing): media import, trim/split/delete/merge, speed (constant + curve), reverse,
freeze frame, keyframe animation, crossfade+more transitions on the primary video track, overlay
video tracks + multi audio tracks in export, text overlays, MP4 export, resizable panels, proxy
transcoding for codecs Chromium can't decode, filmstrip thumbnails + waveforms, media grid,
standalone media preview, MM:SS ruler, aspect-ratio-aware preview.

Recently added (this track of work — all on `main`, pushed to github.com/Kngq/Freecut):
1. **Font selection for text** — `FONT_CATALOG`; `TextClip.fontFamily`; threaded into the preview
   `ctx.font` and the ffmpeg `drawtext fontfile=`. Dropdown in the Inspector text editor.
2. **Auto-captions (local)** — `electron/main/transcribe.ts`: whisper.cpp (`whisper-cli` from PATH/
   Homebrew) + a once-downloaded GGML model (`ggml-base.en.bin`) in `userData/whisper/`. ffmpeg
   extracts 16kHz WAV → `whisper-cli -oj` → parsed segments → `addCaptionClips` adds subtitle-style
   text clips. UI: MediaBin "Captions" tab (`CaptionsPanel.tsx`). Graceful when binary/model absent.
3. **Top bar cleanup** — removed Split/Freeze/Play/skip; play-pause + skip indicator now lives
   under the preview (`Preview.tsx` `.preview-controls`). Spacebar still toggles play.
4. **Preview effects/transitions without a clip** — `EffectPreview.tsx` renders a live looping
   sample-frame per effect (reusing shared effect math) and a JS approximation per transition,
   always visible in the MediaBin Effects/Transitions tabs.
5. **Inspector tabs** — Video / Adjust Speed / Animation for a selected media clip.
6. **Multiple video/audio tracks** — add-track buttons in the timeline toolbar (model + export
   already supported overlays; this adds the UI + per-lane drop routing).
7. **Aspect ratio** — `ASPECT_PRESETS` (portrait/landscape/square/4:3/cinema) + `setCanvasSize`
   store action + a Toolbar dropdown. Preview + export both read `project.canvas`.
8. **Background removal (scaffold)** — `electron/main/background.ts`: optional `onnxruntime-node`
   + a once-downloaded U²-Net ONNX model; ffmpeg frames → per-frame matte → alpha → ProRes 4444.
   UI: "Background removal (beta)" in the Inspector Video tab. Graceful when runtime/model absent.
9. **Explanatory import errors** — unsupported/unreadable files now surface a specific reason
   (which type, or "couldn't be read") via a non-modal toast, listing supported formats.
10. **Track height modes** — CapCut-style short/default/tall selector in the timeline toolbar
    (`layoutStore.trackHeight`, persisted). Short = name bar only; tall = taller + thicker borders.
11. **Ruler lines** — the timeline scale is now classic major/minor tick lines (not boxes).
12. **Inspector project details** — when nothing is selected, the Inspector shows project name,
    file path, aspect ratio, resolution, frame rate, color space, duration, track/media counts,
    and proxy status.
13. **Proxy option** — a "Use preview proxies" toggle (Inspector project view, `layoutStore`)
    gates proxy generation on import.

## Build / verify commands
- `npx tsc -p tsconfig.json --noEmit` — typecheck (passes clean).
- `npx vitest run` / `npm test` — unit tests (63 passing: shared types, ffmpegGraph, effects, store).
- `npx vite build` — builds renderer + main + preload bundles (all pass).
- Agent-driven UI verification: the CDP driver at `scripts/devDriver.mjs` (see
  `.claude/skills/run-freecut/SKILL.md`) — `launch`, `eval`, `screenshot`, `quit`. Screenshots in
  `.dev-shots/` (gitignored).

## Known limitations / good next steps
- **Captions** require `brew install whisper-cpp` (binary not bundled); once installed, the model
  downloads on first use. Consider bundling `@remotion/install-whisper-cpp` to auto-fetch the binary.
- **Background removal** requires `npm i onnxruntime-node` (optional, prebuilt arm64). The pipeline
  is per-frame (temporal flicker possible) and outputs a ProRes 4444 `.mov` path — the
  import-as-overlay wiring (swap the clip to the matted result) is still a TODO.
- **Overlay video tracks** are contiguous per-track rolls (clips butt from 0); free positioning of
  an overlay clip at an arbitrary start isn't exposed yet (export already honors `clip.start`).
- **fontfile** paths in export are macOS system-font paths; a cross-platform font resolver (or
  bundled fonts) would make export font selection portable.

## Git
- Remote: `https://github.com/Kngq/Freecut.git` (origin). Branch `main`.
- Working tree should be committed & pushed after each feature chunk.
