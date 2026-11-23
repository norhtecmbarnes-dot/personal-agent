# Video Editing & Assembly — Runbook

How to turn generated clips + an audio track into the final film. Follows the same conventions as the other runbooks: verify everything, never trust a single signal, keep every intermediate.

Applies to: re-editing existing films (reordering, retiming, re-voicing), and fresh assemblies. Tools: ffmpeg/ffprobe (primary), FilmCraft (optional, see warnings). No GUI editor is required.

---

## 0. Hard rules

1. The audio track is the master clock. Picture is conformed to audio, never the reverse.
2. **Never** let total video run short of audio. If video < audio, the tail is black/silent — this failure already shipped twice. Check **both** stream durations after every export, not the container's.
3. Every export goes to a new filename (`Name-v2.mp4`, `Name-v3.mp4`…). Never overwrite the previous cut; the owner compares versions.
4. Verify every export by extracting frames at known timestamps AND running ffprobe. "Export succeeded" is not verification.
5. No loudness normalization unless explicitly requested; delivery is the owner's call.

---

## 1. Inputs to collect before touching anything

- Ordered clip list (`dir/*.mp4`) + the VO/music track.
- The **beat map**: segment → {source clip, in-point, out-point} and, for VO-synced works, the timestamp of each beat's first sung/spoken word.
- For narration-synced work: measure the VO first (silencedetect for speech; RMS envelope/autocorrelation for sung music — whisper is blocked on this machine (Application Control policy)). Do NOT space beats evenly; songs are not metronomic against scene math.

Commands:
```sh
ffprobe -v error -show_entries format=duration -of csv=p=0 clip.mp4   # per clip
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,r_frame_rate clip.mp4
ffmpeg -i song.mp3 -af silencedetect=noise=-28dB:d=0.35 -f null -      # speech phrase boundaries
```

## 2. Choose the verification pair FIRST

Pick ~8–12 probe timestamps spanning every beat (one frame per beat, plus two near the end). You will re-extract these after every export and eyeball them. If any is wrong, the edit is wrong.

## 3. Build path A — ffmpeg filtergraph (default)

One pass, no intermediate re-encodes of sources beyond what the graph implies:

```sh
FF="/path/to/ffmpeg"
# per segment: [i:v]scale=1920:1080,fps=24,setsar=1,<setpts or trim>[vN]
# then: [v0][v1]...concat=n=N:v=1:a=0[outv]
# -map "[outv]" -map <vo_stream> -af adelay=... if VO must start late (e.g., silent title first)
# last-frame hold for tail extension: tpad=stop_mode=clone:stop_duration=<seconds>   # NOT stop= (that is FRAMES)
# export: -c:v libx264 -crf 17 -preset medium -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart
```

Timing each segment:
- Target duration **shorter** than clip → `trim=start=0:duration=<D>` (never speed video up to fit).
- Target duration **longer** than clip → `setpts=<D/clip_dur>*PTS` (slow motion, fine for calm shots).
- Need to hold the last frame → `tpad=stop_mode=clone:stop_duration=<seconds>`.

Example (v4 Rainbow Garden): silent 3.2 s title card, VO delayed by `adelay=3200|3200`, 11 animal clips concat'd after it, final THE-END frame cloned for the tail so video == audio at 96.0 s. Zero regeneration was needed; all changes were reordering/timing/padding of existing assets.

## 4. Build path B — FilmCraft (use only if timeline interaction needed)

`filmcraft-cli.exe run build.jsonl` with: `file.newProject` → `file.newSequence` (1080p24) → `file.import` → `sequence.open` → `timeline.place` (insert:true for back-to-back) → optional `file.newBlackVideo` → `file.saveAs` → `file.exportMedia` (h264/1080p/crf 19/aac, wait:true).
Known failure: one export produced a silent, black, double-length film that passed "export ok". **FilmCraft output is guilty until proven innocent — always frame-check after.** Prefer path A unless you need FilmCraft's tooling (e.g., its text/title rendering).

## 5. Editing operations, in order of preference

1. **Reorder** (move a scene): reorder the segment list. Cheapest, no regeneration.
2. **Re-time** (stretch/trim): setpts/trim per segment. Free.
3. **Overlay/pad** (title card, hold last frame, black): tpad / still-image loop. Cheap.
4. **Replace a shot**: regenerate that beat only (see kids-song-video-workflow.md §5–6), swap file, rebuild. One clip, one verify.
5. **Rebuild the song/VO sync**: re-derive the beat map from measured audio; never nudge by hand without re-measuring.

## 6. The owner-driven re-time loop (this is the NORMAL edit cycle)

Timing decisions come from the owner watching — the agent cannot judge whether a scene *feels* early. The loop:

1. **Owner reports in plain language**: "orange should come after red", "yellow is too early", "hold the green shot longer".
2. **Agent reorders first.** Reordering costs nothing; regeneration of misplaced shots is almost never needed — the material is usually right, just placed wrong.
3. **Get timecodes, not impressions, when sync depends on the song/VO.** Ask for one or two timestamps ("about what second does 'Yellow as a sunbeam' start?"). One question beats three blind re-exports. Do not guess and ship.
4. **Hold frames instead of regenerating.** `tpad=stop_mode=clone:stop_duration=<s>` on the segment BEFORE the beat that must wait. A frozen held shot reads as intentional stillness; a sped-up scene reads as a mistake.
5. **Keep the global budget.** Audio length is fixed, so every second added anywhere is subtracted elsewhere (usually the END-title hold, or trimming a segment). Always compute the new segment map, print it, then build and verify.
6. **One number at a time.** If one beat still drifts after a pass, change that single duration and rebuild — do not re-solve the whole timeline without new evidence.
7. **Every pass ends the same**: re-export → `ffprobe` BOTH stream durations → extract the probe frames → owner watches. No pass ships unverified.

Rules of thumb learned the hard way:
- Asking "what second does X happen at?" is faster and more accurate than any waveform analysis we've tried on sung audio.
- A single freeze-frame per offending beat is enough; freezing more than two consecutive beats starts to feel static — redistribute instead.
- Never let the fix for beat N silently steal from beat N+1's screen time without telling the owner in the re-timing summary.

## 7. Verification protocol (run EVERY export)

```sh
ffprobe -v error -show_entries stream=codec_type,duration -of default=noprint_wrappers=1 out.mp4
# both streams present; container duration ≈ max(streams)
ffmpeg -ss <probe-ts> -frames:v 1 out.mp4 probe_<n>.png   # one per beat + last frame
```
Also confirm: expected order of scenes, no black frames, title card legible, end card legible, audio clearly present from t=0 for VO films (or from the intended delayed start), and nothing after the final intended frame.

## 8. Pitfalls log (all hit for real)

| Pitfall | Symptom | Fix |
|---|---|---|
| `tpad=stop=` | pads only `stop` **frames** (≈0.3 s "did nothing") | use `stop_duration=<seconds>` |
| Container duration reported, stream durations not checked | 90.8 s film looked fine, last 9 s black | `-show_entries stream=duration` both streams |
| Video shorter than VO | black/silent tail | extend last frame (tpad clone) or re-time beats to VO exactly |
| Concat without normalizing fps/sar | A/V desync or conform errors | `fps=24,setsar=1,scale=...` on every input leg |
| Evenly-spaced beats | scenes drift from lyrics (blue/purple slip) | ask the owner for cue timestamps or measure from audio (see §6) |
| Speeding clip up to hit a shorter slot | judder/weird action | trim instead of speeding up |
| Trusting export success | corrupt/black render shipped | extract ≥8 frames before calling it done |
| Overwriting previous cut | lost comparison point | always `-v2`, `-v3`, `-v4`… |

## 9. When to hand this back to the human

Any quality/direction judgment (does this gag land? is the pacing right for kids?) is the owner's call. Agent proposes; owner watches; agent re-cuts from the note.
