# Kids' Song → Picture-Book Music Video — Production Workflow

**Status:** proven end-to-end once (The Rainbow Garden, 2026-11-22). This is the generalised recipe for animating an original children's song into a 16:9 sing-along video using CloneVoice (song) + VideoExpress (images/video) + ffmpeg/FilmCraft (assembly). Cost class: ~1 song + 12 images + 12 clips. Publish nothing without owner sign-off.

Audience: kids ~3–6. Goal: teach something (colors, letters, counting) with a repeatable hook.

Read this whole file before starting. Every step was paid for once already — don't relearn it.

---

## 0. HARD RULES

1. Song first, always. Never generate images before the VO timestamps are known.
2. One generation job at a time; never burst >5 (extra submissions are silently discarded with HTTP 200 and never appear).
3. Visual beats must follow the SONG'S order and timing, not the lyric file's line order blindly. Map beats to what is actually sung, when.
4. One idea per shot. Single gentle motion per clip. No spinning/rotation of characters (image models produce fused anatomy). No crowd scenes with multiple distinct faces.
5. Text in frame: at most one word per shot, and it must be the teaching word ("RED", "3", "A"). Anything else garbles.
6. Verify everything from the finished file, not from thumbnails or toasts. Screenshots, ffprobe, extracted frames.
7. Never publish/share/upload. Output stays local until the owner approves distribution.

## 1. Inputs to fix first

- Topic + the ONE takeaway (e.g. colors).
- Age band and tone (here: 3–6, bright, sincere, not ironic).
- Cast: a small animal cast works best (robin, kitten, chick, frog, bluebird, butterfly). Name them once and reuse the same list verbatim in EVERY prompt — models do not keep character consistency unprompted.
- Song structure: [Verse]…[Chorus]…, max ~1300 chars, ~85–95 s. Keep chorus identical each time (it will be reused visually).
- Verse order == rainbow/spectrum/teaching order. Check it twice — the film inherits this order.

## 2. The song (CloneVoice → Create Music)
- Style field: `Kids-Rhymes, children choir, ukulele, bright, playful` (≤ ~5 descriptors; more confuses it).
- Language: English. Voice: whatever the style yields — do NOT force a cloned adult voice for kids' songs.
- ToS checkbox: verify ticked; if you must tick it, the owner ticks it, not you.
- Lyrics: plain text with [Verse]/[Chorus] tags. Keep lines short; commas fine; periods fine (they ARE the phrase breaks in singing).
- Embed timing hints naturally: repeated refrain lines give the chorus its anchor.
- Create Music → wait → download MP3 → `ffprobe` duration A. Spot check loudness: mean ≈ −15 dB, max < 0 dB is fine; do not "fix" loudness without being asked.
- One regeneration max if it's off-key/off-topic; then ask.
- **TTS/period rule (owner-supplied):** a period forces a TTS pause. Do not put periods inside names or abbreviations ("Robert E Lee", never "Robert E. Lee"). Commas are musical breaths — use freely.

## 3. Timing analysis (ffmpeg, no ML needed)

`silencedetect` is useless for continuous sung music. Use an RMS envelope + autocorrelation instead:

1. Decode: `ffmpeg -i song.mp3 -f f32le -ac 1 -ar 22050 song.raw`
2. RMS envelope at 50–100 ms hop; find the song's pulse via autocorrelation of the onset strength (expect ~0.35–0.36 s hop ≈ 8ths, ~170 bpm feel, or ~0.71 s / ~85 bpm pulse).
3. Find section boundaries: the repeated chorus is self-similar — autocorrelate the whole signal; the section period (typically ~8 s here) recurs. Verify by eye against the envelope plot (print a coarse bar chart; look for the deep dip near the dramatic pause before the final chorus).
4. Map the lyrics onto the detected grid. Confirm by checking that the color words land where expected; adjust the one or two lines that fall between grid lines.
5. Produce a beat table: `beat | seconds | lyric anchor | visual`. (For Rainbow Garden: title→intro; one beat per verse colour; chorus beats wherever the refrain lands — reuse the dance/line-up clip for every chorus.)

Do NOT eyeball-evenly-space the beats. The blue→purple verses run together with no chorus between; an even grid puts the PURPLE visual on the BLUE line and the whole colour sequence slides out of sync. This was the single biggest quality bug in v1–v3.

## 4. Beat design (the visual grammar)

- One clear subject, one clear idea, one caption max. Red = red things only.
- Palette discipline: explicitly ban neighbors ("absolutely no orange anywhere" for the RED beat). Models drift orange.
- Text, when present, is the ONLY text; spell the caption exactly, e.g. `The only text in the image is the single word RED in chunky crayon letters, bottom-left corner.` Verify by eye; if missing, regenerate once with "The only text in the image is the single word RED" phrasing.
- Faces forward or profile, bodies still unless the clip needs motion. NO turning, spinning, or backs-turned twisting — that is when heads/limbs break.
- Walking-away shots: name every animal in order ("first a robin, then …") and say "these are animals, not humans" — otherwise the model defaults to human children.
- Flying/dancing casts: keep to "bob and sway side to side"; nothing rotational.
- Cast list reused VERBATIM from a single canonical sentence everywhere.

## 5. Image generation (VideoExpress)
- Create Video From Prompt → Image tab is embedded there; Image Type = `Other` (native `<select>`, set via JS value + `input`/`change` events).
- Creative mode ON, Auto-enhance OFF, Public gallery OFF, 16:9.
- Prompt = [beat description] + [global style suffix]:
  ` — children's picture-book illustration, chunky rounded shapes, crayon and gouache texture, bright saturated colors, simple friendly faces, soft paper-grain background, no extra text, no watermark.`
  (For caption beats, add: `The only text in the image is the single word X in chunky letters, bottom corner.`)
- One image per beat. If the caption is wrong/missing on the only verification frame, ONE regeneration, then move on.

## 6. Clip generation
- Same dialog → Create Video. Manual length ON (~6–9 s), Video only ON, enhance OFF, gallery OFF.
- Motion brief: ONE slow camera OR one small subject motion. Never both. Examples: "robin hops once and pecks; camera pushes in slowly"; "confetti drifts down; friends bob in place; camera holds".
- Prompt prefix must carry the beat slug: `RainbowGarden-07 — Image-to-video. …` so library items are greppable.
- Submit ONE at a time. Poll `GET /api/library/get_media/…` (via the logged-in page context) every ~15 s; success == `status: completed` appears; trust the API, never a toast.
- "Create Video" silently does nothing for a fraction of submits; verify + resubmit (max 3) before calling it stuck. CDN files 404 for the first ~2 min after completion — poll and retry downloads before concluding failure.

## 7. Assembly (ffmpeg direct; FilmCraft only if you keep its timeline)
Per beat: if beat duration D < clip length, `trim=0:D`; else `setpts=(D/clip)*PTS`. Concat all, one map for video, VO on audio, `-shortest` off, verify both streams ≈ song length (`ffprobe -show_entries format=duration`).

Why not even stretch: kids' eyes notice subject pops; setpts on gentle clips is invisible, but syncing to the sung grid is the standard that matters.

Export: H.264, 1080p, 24 fps, CRF 17–19, AAC 192k, `+faststart`. Keep all intermediate `.mp4`s.

FilmCraft gotcha if you use it: one export produced a silent double-length black render; ALWAYS verify duration AND extract ≥6 frames before shipping anything built there.

## 8. QA checklist (all mandatory)
- [ ] Video length == song length (±0.1 s), audio+video streams both full length
- [ ] Frame at the exact beat boundaries: correct scene, correct order, colors on the right words
- [ ] Every color word appears on screen exactly once, spelled right, legible
- [ ] No extra text anywhere; no extra limbs; no scary imagery; consistent cast
- [ ] Listened end-to-end with the picture: verses land on verses, chorus lands on chorus actions
- [ ] No black frames, no frozen 5+ second holds unless intended
- [ ] File stays local; owner watches it before any distribution

## 9. Known failure modes (learned the expensive way)
- Library shows nothing after submit → submission silently dropped; resubmit one at a time. 
- `Completed` but download 404 → CDN lag; retry with backoff.
- Blue beat drifting late / purple early → you spaced beats evenly instead of mapping chorus repetitions; re-derive the grid.
- Orange-heavy "red" beat → palette words in prompt ("absolutely no orange") are mandatory.
- Text captions invented/duplicated → single-word caption rule; one retry then move on.
- Faces/heads mutating → remove rotations; face forward; single motion.
- Audio louder than −1 dBTP → leave it; kids' tracks are mastered hot by design; only normalize if the owner asks.
- Human actors instead of animals → name the species + "these are animals, not humans".
- Film longer than VO → black tail: picture must be exactly song-length (compute from measured A, not the target).

## 10. Budget
~1 song generation + 12–14 images + 12 clips ≈ 30–35 credit-ish units, 60–120 min wall clock including verifications. Keep every frame/log until the owner signs off.
