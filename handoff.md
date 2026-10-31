# Handoff — freecut

## Goal

freecut is a barebones, from-scratch video editor (Electron + React + TypeScript + Vite) inspired by CapCut's UX, using its own `.fcproj` JSON format. v1 scope: multi-track timeline, trim/split/delete clips, media import, preview playback, text overlays, crossfade transitions on the primary video track, and MP4 export.

## Current state

- Working tree is **clean** on `main`, in sync with `origin/main`. No uncommitted changes.
- `npx tsc --noEmit` passes with no errors.
- `npx vitest run` passes: 21/21 tests (`src/shared/types.test.ts`, `src/shared/ffmpegGraph.test.ts`).
- Last commit (`a62321a`, this session): wired up the Audio and Text tabs in the media bin — tabs are now switchable, Audio tab filters the asset pool and reuses the Media tab's import/drag/double-click flow, Text tab has a "+ Add text" button inserting a clip on the Text track. Verified via the CDP driver per the commit message (synthetic audio asset dragged onto the Audio track, text clip added via the button).
- Core features already implemented per recent history: trim/split/delete/merge, speed control (constant + piecewise curves), reverse playback, freeze frame, keyframe animation (position/scale/opacity), resizable Media/Preview/Inspector/Timeline panels, crossfade transitions (`src/shared/ffmpegGraph.ts`, primary video track only via `xfade`), proxy transcoding for codecs Chromium can't decode natively, and MP4 export (`electron/main/export.ts`).

## Files touched this session

None. No implementation work has been done in this conversation — this handoff was requested at the very start of the session, before any task was assigned.

## What failed

Nothing failed. There is no in-progress or broken work to report; the repo was already in a clean, passing state when this handoff was written.

## What to do next

No task was specified in this conversation, so there's no concrete next step to resume. If picking this up fresh, likely candidates based on the v1 scope and current architecture:

- Confirm whether MP4 export has a UI entry point beyond what's wired in `Toolbar.tsx`/`Home.tsx` — worth an end-to-end export smoke test (import → trim → export → verify output file).
- `ffmpegGraph.ts` only supports crossfade transitions on the *first* video track; later video tracks are overlay-only by design (see memory `freecut-project-scope`) — confirm this limitation is still acceptable or surface it in the UI.
- Check in with the user on what the next feature/fix target actually is before starting work.

## Environment notes

- `extract-zip`/`yauzl` can silently truncate `npm install`'s Electron download in this shell — if `node_modules/electron/dist` looks tiny, re-extract the cached zip with system `unzip`/`ditto` instead of blindly reinstalling. See memory `freecut-env-quirks` for the full recipe (including an Electron version-revocation gotcha).
- This Bash tool's shell has no usable WindowServer connection — GUI launches of the Electron app must be verified by the user directly or via a screenshot/computer-use tool, not assumed to work from a headless `npm run dev`.
