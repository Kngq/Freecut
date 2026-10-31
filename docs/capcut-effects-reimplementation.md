# How CapCut builds its transitions and effects, and how freecut could rebuild them

Sources: the local CapCut desktop install and its download cache
(`~/Movies/CapCut/User Data/Cache/effect/`, 264 effect packs, about 3.6k shader files), plus
the cached catalog API responses in `Cache/ressdk_db/*/rp.db` (`http_cache` table, about 24k
entries with names and parameters). Nothing was run or hooked. Each item is tagged by how
much we actually saw:

- **[code]**: we read CapCut's Lua script or GLSL shader for it.
- **[catalog]**: only the catalog metadata (parameter names and defaults) is cached. The pack
  itself was never downloaded.
- **[standard]**: no CapCut evidence is cached locally, so the notes describe the usual technique.

## How CapCut's system works (what we saw)

- **The engine.** ByteDance calls it "Amazing", and the effect layer inside it "Lumi". Every
  effect pack is a small scene: Lua scripts drive GLSL passes that render to offscreen render
  targets. The shaders ship as plain GLSL ES and Metal source under
  `xshader/shaderLib/shaderGLES/<hash>.frag`. The `.ausl` sources are encrypted. Shared modules
  (`LumiGaussianBlur`, `LumiMotionBlur2D`, `LumiSShake`, `LumiGlitchSignal`,
  `LumiLinearWipe`, `LumiDisplacementMap`, `LumiTurbulenceDisplacement`, `LumiDeepGlow`,
  `LumiColorama`, …) are copied into each pack that uses them.
- **They are After Effects comps.** `LumiExportData.lua` holds `ae_keyframes`, and each
  keyframe has cubic-bezier easing handles such as `{0.6, 0, 0.4, 1}`. `AETools.lua`
  evaluates those curves every frame. Most effects are AE-style layer stacks (transform,
  blur, glow, displacement) animated by those curves, not hand-written effects.
- **Transitions.** Catalog type `19`. The engine gives the pack two textures,
  `#TransitionInput0` (outgoing clip) and `#TransitionInput1` (incoming clip), plus a
  normalized time from 0 to 1. `sdk_extra.transition` = `{isOverlap: true, defaultDura: 2}`,
  so every transition overlaps the two clips. Newer packs expose a `progress` value from 0
  to 1 and a few named knobs (for example, Bars Glitch has `maxOffset=0.2`,
  `rgbIntensity=0.05` and `blockScale=25`).
- **Video effects.** Catalog type `7`. They are applied to one clip (or an adjustment
  segment). Most expose only `effects_adjust_speed`, `effects_adjust_intensity` and
  `effects_adjust_luminance`, each from 0 to 1, with a default `effect_duration` of 3000 ms.
- **Asset-based packs.** Some packs ship a prerendered overlay video. Finger Swipe contains
  `resource/video/finger2.mp4`, for example. Light leaks and film burns almost certainly
  work the same way: a video layer composited on top.

**Architecture for freecut:** Preview currently draws with Canvas 2D, and export is an
ffmpeg `filter_complex` with `xfade` (`src/shared/ffmpegGraph.ts`). To match CapCut, add a
WebGL2 pass with the signature `(texA, texB, progress, params) -> frame` for transitions and
`(tex, time, params) -> frame` for effects. Drive `progress` through a cubic-bezier ease.
For export, either map each effect to an ffmpeg equivalent (listed below), or render frames
with the same WebGL code and pipe them to ffmpeg, which avoids writing everything twice.

---

## Transitions

| # | Name | CapCut evidence | Reimplementation |
|---|------|-----------------|------------------|
| 1 | **Cut** | None needed. | No transition: the clips butt together. This is already the default. |
| 2 | **Fade (black/white)** | [code] The `Fade In` pack (`Transform.lua`) tweens `_alpha` from 0 to 1 through a bezier ease. [catalog] "Black Fade", "Bleach Fade" and "Flash White" (`flashIntensity=1.5`, `zoomAmount=0.2`). | Pick a color C. For p < 0.5 mix A→C over `p*2`; for p ≥ 0.5 mix C→B. Export: `xfade=transition=fadeblack` or `fadewhite`. |
| 3 | **Dissolve / cross dissolve** | [catalog] A simple "Dissolve" exists. CapCut's "Cross Fade" is actually a crystal shatter (`crystalScale=18`, `collapseAmount=0.35`). | `mix(A, B, ease(p))`. For a grainy "dissolve", compare a noise texture against p per pixel. Export: `xfade=fade` or `xfade=dissolve`. |
| 4 | **Zoom in/out** | [code] `Transform.lua` + `gles2_filter.frag` define `BLUR_SCALE` (a 25-tap radial blur toward the center) and `BLUR_MOTION` (7 taps). The blur step = `blurIntensity / duration`. `LumiMotionBlur2D` mirror-wraps UVs (`abs(mod(uv-1,2)-1)`), so zooming never shows black edges. | A's scale goes 1→~1.5 over the first half, then B's scale goes ~1.5→1 over the second half, with a hard switch at 0.5. Apply a radial blur whose strength follows the rate of change of the scale, and sample with mirror-repeat. Export: a custom `xfade` expression, or scale+crop plus `zoompan`. |
| 5 | **Slide / push** | [catalog] "Bars Slide" (`tileCount=8`, `slideDistance=1.2`, `direction`), "Dimensional Push", "Gallery Slide". | Offset both textures by the same vector: A's offset goes 0→-1 and B's goes +1→0 along the chosen direction, eased. Export: `xfade=slideleft`/`slideright`/`slideup`/`slidedown` (push). |
| 6 | **Whip pan / blur pan** | [code] `LumiMotionBlur2D` takes several transform samples across a shutter window (position, rotation, scale and pivot arrays), averages them, and mirror-wraps the edges. [catalog] "Blur Swipe-Right", "Fast Swipe", "Blurry Slide" (`blurStrength=0.75`, `edgeBlurBoost=0.6`). | A push (item 5) with a steep in-out ease (for example bezier `0.7,0,0.3,1`), plus a directional blur along the motion whose length matches per-frame velocity: about 16–32 taps, mirror-wrapped. Switch A→B at the peak velocity. Export: `xfade=hblur`, or WebGL frames. |
| 7 | **Glitch** | [code] `LumiGlitchSignal`: (a) converts to YIQ and smears chroma horizontally (chroma bleed); (b) finds horizontal edges and pushes a "signal" offset; (c) splits channels with a horizontal offset (`d2dIntensity`); (d) adds Perlin-based hue and chroma noise plus moiré (`hueNoise`, `chromaNoise`, `moireNoise`, `randomSeed`). [catalog] "Bars Glitch": `maxOffset=0.2`, `rgbIntensity=0.05`, `blockScale=25`. | Split the frame into horizontal bands of height `1/blockScale`. Each band gets a random x offset (hash of band index + floor(time*fps)) scaled by `maxOffset * sin(pi*p)`. Sample R, G and B with ±`rgbIntensity` offsets. Hard-swap A→B at p = 0.5. Export: `rgbashift` + `noise`, or WebGL frames. |
| 8 | **Spin** | [catalog] "Cube Spin", "Flowing Spin", "Earth Core Spin". The pack internals were not cached. | Rotate A from 0° to 180° (or 360°) about the center while zooming in. Switch to B at p = 0.5 and finish the rotation. Add a rotational (angular) blur proportional to angular velocity, and mirror-wrap the edges. |
| 9 | **3D cube / flip** | [catalog] "3D Flip", "Card Flip" (`edgeSoftness=0.35`, `lightingStrength=0.45`, `blurAmount=0.4`), plus about 10 cube variants. | Draw two quads in WebGL with a perspective matrix. **Flip:** rotate the card from 0 to 180° on Y and show B once the back face is visible. **Cube:** put A and B on adjacent faces of a cube and rotate it 90°. Shade each face by `lightingStrength * dot(normal, view)`. Export: WebGL frames. |
| 10 | **Shake** | [code] `LumiSShake`: x, y, z (scale) and w (rotation) offsets each = `sin(pi*t*frq + phase)*amp` + a "random" wave that sums 3 sines at frequency ratios 2/3/5 with weights 0.5/0.32/0.18, phase-shifted by `seed % k`. R, G and B can get separate amplitude ratios (`rAmpRatio`, …), which gives RGB-split shake. Optional motion blur averages 2–12 sub-frame samples across ±0.5/30 s. | Copy this directly: it is cheap, deterministic and seeded, and needs no noise texture. For a transition, multiply the amplitude by `sin(pi*p)` and hard-cut at 0.5. Export: `crop` with per-frame x/y expressions, or WebGL frames. |
| 11 | **Light leak / film burn** | [catalog] "Leak 1/2" (type 7, `is_business`), "Burn Reveal", "Blossom Wink" (`leakStrength=0.85`, `grainAmount=0.08`, `vignetteStrength=0.4`, `flashStrength=0.9`, warm and hot leak colors). Inferred from the Finger Swipe pack: the overlays are videos. | Either composite a stock leak video with **screen/add** blending (simplest, and how CapCut does asset-based packs), or generate one procedurally: animated soft radial gradients in warm colors (about `#FA9E4C` → `#FFEBC7`), added on top, with a brightness flash around p = 0.5 hiding the A→B swap. Export: `blend=all_mode=screen` with an overlay input. |
| 12 | **Mirror / kaleidoscope** | [catalog] "Mirror" effect (type 28). [code] The UV mirror-wrap helper appears in several shaders. | Convert UVs to polar coordinates around the center and fold the angle with `a = abs(mod(a, 2pi/N) - pi/N)`; the number of segments N ramps up with p. Mix A→B in the middle. A simple mirror is `uv.x = 0.5 - abs(uv.x - 0.5)`. Export: `hflip` + `hstack`, or WebGL frames. |
| 13 | **Liquid / ink** | [code] `LumiTurbulenceDisplacement`: fractal noise (`u_Complexity` octaves from 1 to 10, `u_Evolution` = time, sub-scale/rotate/offset) computed twice with seeds 2.11 and 9.71 to get x and y displacement, which then shift the UVs. `LumiDisplacementMap` displaces using the channels of a map texture. [catalog] "Flow Fade" (`brushScale=22`, `edgeSoftness=0.12`, `strokeAngle=0.65`, `jitter=0.28`). | **Liquid:** `uv += (fbm(uv*scale, t)-0.5) * amount * sin(pi*p)`, then mix A→B. **Ink:** build a mask from `smoothstep(p - soft, p + soft, fbm(uv*brushScale))`, optionally stretched along `strokeAngle`. B shows where the mask = 1, and you can darken the mask edge to look like wet ink. |

## Effects (applied to a single clip)

| # | Name | CapCut evidence | Reimplementation |
|---|------|-----------------|------------------|
| 1 | **Zoom (Ken Burns)** | [code] The `Transform.lua` scale tween with bezier easing (the same machinery as the zoom transition). | Keyframe scale (1.0→1.2) and translation across the clip using an ease. In Canvas 2D this is just `drawImage` with a source rect, so it needs no shader. Export: `zoompan=z='1+0.2*on/N'`, or `scale`+`crop` with expressions. |
| 2 | **Shake / camera shake** | [code] `LumiSShake` (see transition 10). [catalog] "Camera Shake": `speed`, `luminance` and `intensity` (each from 0 to 1). | Same summed-sine waveform as transition 10, applied over the whole clip. `speed` maps to `frqRatio` and `intensity` to `ampRatio`. Scale up slightly (about 1.05×) or mirror-wrap so the edges never show. |
| 3 | **Glitch / VHS / datamosh** | [code] `LumiGlitchSignal` (see transition 7), with a VHS chain of chroma bleed, sharpening (`sharpen0`/`1`), vertical blur and a LUT (`lutImageTexture`). [code] "Night Target" combines GlitchSignal and Colorama. | **VHS:** chroma bleed in YIQ, plus scanlines (`0.9 + 0.1*sin(uv.y*H*pi)`), plus a little noise and a slight horizontal wobble. **Glitch:** band offsets + RGB split triggered at random times. **Datamosh:** true datamosh needs codec tricks (dropping I-frames); fake it by blending the previous frame displaced by an optical-flow approximation. Export: `rgbashift`, `noise`, `lutyuv`, or WebGL frames. |
| 4 | **Flash / strobe** | [catalog] Video effects "Flash 2", "Color Strobe" and "Dance Flash"; transitions "B&W Strobe" (`defaultDura` 0.6) and "Flash White" (`flashIntensity=1.5`, `noiseStrength=0.3`). | `rgb = mix(rgb, white, f(t))`, where f is a short pulse such as `exp(-k*(t - beat))`, fired on beat markers. A strobe is a square wave at N Hz. Overdrive the exposure (`rgb*1.5`) instead of mixing to pure white so detail survives. Export: `eq=brightness=...` with an expression, or `geq`. |
| 5 | **Blur (motion / Gaussian / background)** | [code] `LumiGaussianBlur` (separable X/Y passes, several cascaded levels), `LumiDirectionalBlurs`, `LumiMotionBlur2D`, `LumiBoxBlur`. | **Gaussian:** a separable two-pass blur at a downsampled resolution; in Canvas 2D, `ctx.filter = 'blur(Npx)'` is enough for preview. **Motion:** a directional blur. **Background blur:** draw a blurred, scaled-to-fill copy behind a fitted foreground (CapCut's "canvas blur"). Export: `gblur`/`boxblur`, and `split` → `scale` → `gblur` → `overlay` for background blur. |
| 6 | **Split screen** | [catalog] "Cross Split", "3 Split Frame"; "Split" (type 97, a mask shape). | Tile the frame N×M times, sampling with `fract(uv * vec2(N, M))`, optionally with gutters between tiles. Export: `split=N` + `hstack`/`vstack`, or `tile`. |
| 7 | **Freeze frame** | [standard] CapCut implements this as an edit operation (a still clip is inserted), not as a shader. | Insert an image clip made from the frame at the playhead, then shift the rest of the clip. Export: `trim` + `tpad=stop_mode=clone:stop_duration=D`, or `loop`. |
| 8 | **Vignette** | [catalog] Parameters such as `vignetteStrength` appear inside composite effects (e.g. "Blossom Wink"). There is no standalone vignette pack in the cache. | `rgb *= 1 - strength * smoothstep(r0, r1, length((uv-0.5)*vec2(aspect,1)))`. In Canvas 2D, a radial gradient drawn with `multiply` works. Export: the `vignette` filter. |
| 9 | **Old film / grain / scratches** | [catalog] "Faded Film", "Honey Grain", "Rolling Film"; `grainAmount` inside composites. | Sepia or desaturate with a lifted-blacks curve. **Grain:** per-frame hash noise at about 0.05–0.1 amplitude, added in luma. **Scratches:** a few thin vertical lines at random x positions that persist for a few frames. **Dust/flicker:** jitter the brightness ±3% per frame. A gate weave (sub-pixel y jitter) helps sell it. Export: `noise=alls=20:allf=t`, `curves=vintage`, `vignette`. |

## Suggested build order

1. A shared WebGL2 compositor that does mirror-repeat sampling, a cubic-bezier ease and a
   seeded hash/fbm. Almost everything above reuses these.
2. Cheap wins with direct ffmpeg equivalents: fade, dissolve, slide, Ken Burns, vignette,
   grain, Gaussian blur, split screen, freeze frame.
3. Port the shake waveform (copy the `LumiSShake` math).
4. Glitch, whip-pan blur and spin. These need a directional or rotational blur pass.
5. 3D cube/flip, kaleidoscope, liquid/ink. These need WebGL for export too.
6. Asset-based light leaks and film burns, using screen-blended overlay videos.
