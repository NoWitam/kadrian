# D29 — The MP4 export: pinned FFmpeg, streamed frames, presets, and audio mux

- Status: Accepted — by the project owner on 2026-09-22
- Date: 2026-09-22
- Supersedes: —
- Related: D04, D06, D07, D10, D12, D13, D14, D23, D26, D27, D28,
  [specification](../spike/vertical-spike.md) §5 P5, §6.1, §8, and open
  questions Q2, Q4, and Q7

## Context

P5 asks the Producer to export "an H.264 MP4 without storing all intermediate
frames": verified with `ffprobe` (H.264, `yuv420p`, the expected dimensions,
30/1, 300 frames, an audio stream), with pixel comparisons on the pre-encode
frames of P2 only, a streaming that is measurable (no frame files on disk, a
constant number of frames in flight, peak memory independent of the number of
frames), and both presets of D07. §8 adds a pipe with backpressure, constant
30 fps, audio muxed from `clip-audio`, and FFmpeg's version in the render
manifest. FFmpeg is not installed on the development machine (Q4).

The project owner decided on 2026-09-22:

- **Q4, source.** A static build of BtbN/FFmpeg-Builds for linux-amd64 from a
  dated, immutable release, never an asset or URL containing `latest`, with
  `ffmpeg`, `ffprobe`, libx264, and the native AAC encoder. The binaries are
  downloaded before a render, verified, and mounted read-only into the pinned
  container, which keeps running without a network. The Producer never uses an
  FFmpeg found on `PATH`. A missing binary, a checksum difference, a missing
  libx264, or another version ends the run before the render with a typed error.
- **Q4, encoder.** libx264 in a GPL build, with explicit threads, preset, CRF,
  pixel format, profile, level, `+faststart`, and no variable metadata. The MP4
  need not be bit-exact between runs; frame count, duration, resolution, frame
  rate and time base, codec and pixel format, audio sync, and the manifest must
  agree.
- **Q2.** One source render at 1080x1920 and device scale factor 1. The preset
  `1080p` is that size unscaled; `720p` is `scale=720:1280:flags=lanczos`,
  `setsar=1`, `yuv420p`. The page is never rendered again at another scale.
  Golden frames exist for the 1080x1920 pre-encode frames only.
- **Q7.** Mux only; the audio is always decoded and encoded again (AAC,
  48 kHz, explicit bitrate and channel layout), never stream-copied. Microseconds
  map to samples with integer arithmetic and one rounding rule. `ffprobe` checks
  the streams, the offset, and the durations against a tolerance tied to the
  sample and the AAC frame.
- The render environment's identity in the manifest is no longer the image
  digest alone: it names at least the Playwright image digest, the Playwright
  version, the Chromium revision, the SHA-256 of `ffmpeg` and `ffprobe`, the
  FFmpeg version, and its build configuration.

The review of the plan asked which export would pass the `ffprobe` tests and
still contain other frames than the Producer's pre-encode frames for the same
`(composition, timeUs)`, or hold all frames in memory or on disk. Its answers
shaped 29.3, 29.4, and 29.7: a wrong frame at an index that no golden
timestamp samples; a manifest that hashes the right bytes while FFmpeg gets
others; a 720p export from another render; dropped or duplicated frames behind
a correct count; all frames buffered and then written one by one; writes that
ignore backpressure and pile up in the stream's buffer; frame files in a
directory nobody watches; an export with its own render path; and a Custom
HTML element that navigates during the last frames, after which the protocol of
D23 alone would not notice anything before the capture (D23.9).

Evidence gathered on 2026-09-22:

1. GitHub API, `BtbN/FFmpeg-Builds`: the release `autobuild-2026-09-21-13-55`
   (published 2026-09-21T13:56:06Z) has the asset
   `ffmpeg-n8.1.3-linux64-gpl-8.1.tar.xz`, 149 352 656 bytes, whose digest the
   API reports as `sha256:dfe7728e01099e22a6fc7a65355ed4f1b65468e1dbe0015f07c45286b486cc59`;
   the download had exactly that SHA-256. It is the point release `n8.1.3`
   without commits after the tag, and older than one day when it was chosen.
2. Inside the pinned container (D26.2) with `--network none` and the two
   binaries mounted read-only: their SHA-256 below; `ffmpeg -version` as quoted
   in 29.1; `-encoders` lists `libx264` and `aac`; `/sys/class/net` lists `lo`
   only. The binaries are statically linked except for glibc and `libgcc_s` of
   the image (`ldd`: `libm`, `libdl`, `librt`, `libpthread`, `libmvec`, `libc`,
   `libgcc_s`, `ld-linux-x86-64`), so they run in the pinned image, and the image
   is part of their pin.
3. Chrome DevTools' `Page.captureScreenshot` returns PNG, JPEG, or WebP only.

## Decision

**29.1 FFmpeg (Q4).** The pinned build, repeated as constants in
`@kadrion/producer` (`ffmpeg.ts`):

| Pin                          | Value                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Release tag                  | `autobuild-2026-09-21-13-55`                                                                                                    |
| Asset                        | `ffmpeg-n8.1.3-linux64-gpl-8.1.tar.xz`                                                                                          |
| URL                          | `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-21-13-55/ffmpeg-n8.1.3-linux64-gpl-8.1.tar.xz`       |
| Archive SHA-256              | `dfe7728e01099e22a6fc7a65355ed4f1b65468e1dbe0015f07c45286b486cc59`                                                              |
| `bin/ffmpeg` SHA-256         | `b8404b6fe11bfa0d4970d031b6eb8108d230075e3f3be5fde7fada250f003c54`                                                              |
| `bin/ffprobe` SHA-256        | `a037cf8856a567f6c8e25837786bd8dbfb27f57738d9c42331c48a46f423f270`                                                              |
| Version line (both binaries) | `ffmpeg version n8.1.3-20260921 …` and `ffprobe version n8.1.3-20260921 …`, followed by `Copyright (c) 2000-2026` / `2007-2026` |
| Required encoders            | `libx264` (video), `aac` (audio, native)                                                                                        |
| Platform                     | `linux`/`x64`, inside the image of D26.2                                                                                        |

`ffmpeg -hide_banner -version` in the pinned container printed:

```text
ffmpeg version n8.1.3-20260921 Copyright (c) 2000-2026 the FFmpeg developers
built with gcc 16.2.0 (crosstool-NG 1.29.0.7_b1a94f6)
configuration: --prefix=/ffbuild/prefix --pkg-config-flags=--static --pkg-config=pkg-config --cross-prefix=x86_64-ffbuild-linux-gnu- --arch=x86_64 --target-os=linux --enable-gpl --enable-version3 --disable-debug --enable-iconv --enable-zlib --enable-libxml2 --enable-libsoxr --enable-openssl --enable-libvmaf --enable-fontconfig --enable-libharfbuzz --enable-libfreetype --enable-libfribidi --enable-vulkan --enable-libshaderc --enable-libdav1d --enable-libvorbis --enable-librav1e --enable-librsvg --enable-libxcb --enable-xlib --enable-libpulse --enable-gmp --enable-lzma --enable-liblcevc-dec --enable-opencl --enable-amf --enable-libaom --enable-avisynth --enable-chromaprint --enable-libdavs2 --enable-libdvdread --enable-libdvdnav --disable-libfdk-aac --enable-ffnvcodec --enable-cuda-llvm --enable-frei0r --enable-libgme --enable-libkvazaar --enable-libaribb24 --enable-libaribcaption --enable-libass --enable-libbluray --enable-libjxl --enable-libmp3lame --enable-libopus --enable-libplacebo --enable-librist --enable-libssh --enable-libtheora --enable-libvpx --enable-libwebp --enable-libzmq --enable-lv2 --enable-libvpl --enable-openal --enable-liboapv --enable-libopencore-amrnb --enable-libopencore-amrwb --enable-libopenh264 --enable-libopenjpeg --enable-libopenmpt --enable-librubberband --disable-schannel --enable-sdl2 --enable-libsnappy --enable-libsrt --enable-libsvtav1 --enable-libtwolame --enable-libuavs3d --enable-libdrm --enable-vaapi --enable-libvidstab --enable-libvvenc --disable-whisper --enable-libx264 --enable-libx265 --enable-libxavs2 --enable-libxvid --enable-libzimg --enable-libzvbi --extra-cflags=-DLIBTWOLAME_STATIC --extra-cxxflags= --extra-libs='-lgomp -ldl' --extra-ldflags=-pthread --extra-ldexeflags= --cc=x86_64-ffbuild-linux-gnu-gcc --cxx=x86_64-ffbuild-linux-gnu-g++ --ar=x86_64-ffbuild-linux-gnu-gcc-ar --ranlib=x86_64-ffbuild-linux-gnu-gcc-ranlib --nm=x86_64-ffbuild-linux-gnu-gcc-nm --extra-version=20260921
libavutil      60. 26.103 / 60. 26.103
libavcodec     62. 28.103 / 62. 28.103
libavformat    62. 12.103 / 62. 12.103
libavdevice    62.  3.103 / 62.  3.103
libavfilter    11. 14.103 / 11. 14.103
libswscale      9.  5.103 /  9.  5.103
libswresample   6.  3.103 /  6.  3.103
```

- `tests/pinned/fetch-ffmpeg.ts` downloads the asset from the URL into
  `.kadrion-cache/ffmpeg/` (ignored by Git) unless it is there, refuses an
  archive with another SHA-256, extracts `bin/ffmpeg`, `bin/ffprobe`, and
  `LICENSE.txt`, and refuses binaries with other checksums. It runs before a
  render, with a network; the render does not.
- `exportMp4` takes `ffmpegPath` and `ffprobePath` explicitly. Before anything
  else touches Chromium it checks, in this order: both paths are absolute and
  exist (`ffmpeg-missing`: a bare name would make the operating system search
  `PATH`); the process runs on `linux`/`x64`; both files have the pinned
  SHA-256; both report the pinned version line; `ffmpeg` reports the pinned
  configuration; `-encoders` lists `libx264` and `aac` (all `ffmpeg-mismatch`).
  `@kadrion/producer` reads no environment variable for this; the CLI does
  (29.10).
- The BtbN project deletes old automatic builds. When the URL is gone, the pin
  still detects any substitute; replacing the build is an amendment of this ADR
  with new checksums and a new measurement, not an edit of the constants.

**29.2 Licence.** The FFmpeg binary used here is built with `--enable-gpl` and
libx264, so it is licensed under the GPL, version 2 or later. Kadrion talks to
it only as a separate process through pipes and command-line arguments; it
neither links nor loads it. At this stage the binary is not part of the
repository and not part of any published package or image of Kadrion: it is
downloaded into an ignored cache by the command of 29.1. The licence of the
repository therefore does not change by this decision (D10). Before an image or
a package that contains this binary is distributed, GPL compliance has to be
prepared: the licence texts (`LICENSE.txt` of the archive) and the
corresponding source code or a written offer of it. The patent obligations of
H.264 (encoding and distribution) are a separate question that needs its own
assessment before any commercial distribution or service; this ADR does not
answer it.

**29.3 Frames flow to FFmpeg, never to disk.**

- **One frame loop for both outputs.** `renderFrames` (D28) and `exportMp4`
  run the same internal sequence: validate, check the frame times, verify the
  assets, check the runtime, open one render session, `load` once, and then
  render, pass the barrier, and capture each frame in order with the same
  `RenderSession.frame` (D28.4, D28.5). `renderFrames` collects the PNGs it was
  asked for; `exportMp4` asks for every frame of the grid, index `0` to
  `frameCount − 1` at `frameToTimeUs(index)`, and keeps none of them.
- **The bytes.** The PNG bytes of `Page.captureScreenshot`, unchanged, are what
  FFmpeg reads (`-f image2pipe -c:v png -framerate <fps> -i pipe:0`). The
  Producer decodes nothing (evidence 3), and the pixel format is decided in one
  place, FFmpeg's filter graph (29.4). The SHA-256 of exactly the bytes written
  to the pipe goes into the manifest (`frames`, one entry per frame).
- **Receipt.** A second output of the same FFmpeg process copies the input
  packets without decoding (`-map 0:v -c:v copy -f framehash -hash sha256
pipe:1`); the Producer compares that list with its own after FFmpeg exits, and
  a difference in count, order, or bytes is `encode-failed`. A manifest that
  hashes other bytes than FFmpeg read is thereby impossible to write.
- **Backpressure.** `FRAMES_IN_FLIGHT = 2`: a frame counts as in flight from its
  `write` until the stream's callback reports it handed to the pipe. The next
  frame is rendered only after the previous write was accepted into that
  window, so the Producer holds at most one rendered frame plus two frames in
  flight, whatever the length of the composition. A window that does not open
  within `encoderTimeoutMs` (default 30 s) is `encode-failed`.
- **Failure.** On every failure the Producer kills FFmpeg, waits for it to
  exit, and removes the partial output file; a render never reports success for
  a file that FFmpeg did not finish with exit code 0.
- **Self-check.** After exit code 0 the Producer reads the output with the
  pinned `ffprobe`: the video stream must hold exactly the composition's frame
  count of packets, and their presentation times must be `index × 512` in the
  time base of 29.4, in order. A dropped, repeated, or shifted frame changes that
  list even when the count still matches; either is `encode-failed`.
- **No frame files.** No code of `@kadrion/producer` writes a file; the only file
  FFmpeg writes is the MP4 (`+faststart` rewrites it in place). A lint rule
  forbids the file-writing APIs of `node:fs` and a dynamic `import` in the
  Producer's sources; the one exception is removing a partial output.
  `createRequire` stays available, because `environment.ts` resolves
  `playwright-core`'s manifest with it: the rule is a tripwire over the source,
  not a sandbox.

**29.4 Encoding.** The arguments, in this order (`<fps>` is the composition's,
`<w>:<h>` the preset's size):

```text
-hide_banner -nostdin -loglevel error -threads 1
-f image2pipe -c:v png -framerate <fps> -i pipe:0
-i pipe:3
-filter_complex <video graph>;<audio graph>   (29.5, 29.6)
-map [v] -map [a]
-fps_mode passthrough
-c:v libx264 -preset medium -crf 18 -profile:v high -level:v 4.0 -pix_fmt yuv420p -threads 1
-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv
-video_track_timescale <fps × 512>
-c:a aac -b:a 128k -ar 48000 -ac 2
-map_metadata -1 -map_chapters -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact
-movflags +faststart -f mp4 -y <output>
-map 0:v -c:v copy -f framehash -hash sha256 pipe:1
```

Measured in the pinned container: the build writes the matrix (`bt709`) and the
range (`tv`) into the stream, and `ffprobe` reports no `color_primaries` or
`color_transfer` for it, with or without `+bitexact`. The arguments still ask
for them, and the manifest records the arguments, so the intent stays reviewable.

`-filter_complex_threads 1` precedes `-filter_complex`. `-fps_mode passthrough`
keeps the input timestamps: frame `i` has the presentation time `i × 512` in the
time base `1/15360`, so FFmpeg can neither drop nor repeat a frame without the
checks of 29.11 seeing it. `+bitexact` and `-map_metadata -1` leave no creation
time and no encoder version string in the file. The manifest records the list
with the output path replaced by `<output>`, so it is the same in every run.
Level 4.0 admits 8 160 macroblocks per frame, exactly 1080x1920, at 30 fps.

**29.5 Presets (D07, Q2).** A preset names the short side of the output. The
composition is rendered once, at its own size and device scale factor 1 (D26.3);
the preset scales in FFmpeg only.

| Preset  | Output for 1080x1920 | Video graph                                                                                         |
| ------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| `1080p` | 1080x1920            | `[0:v]scale=1080:1920:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p[v]` |
| `720p`  | 720x1280             | `[0:v]scale=720:1280:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p[v]`  |

Both graphs name their size, even `1080p`, where it equals the composition's:
one form and one code path. `scale` runs either way, because the conversion
from RGB to YUV happens there and the matrix must be the BT.709 that the stream
is tagged with.

**29.6 Audio (Q7).** Mux only; schema 0.1 allows at most one audio clip (D16),
which "plays an audio asset from its beginning; whatever lies past the
composition end is cut".

- **Samples.** `samples(us) = ⌊(us × 48 000 + 500 000) / 1 000 000⌋`, in
  `BigInt`: the nearest sample, with an exact half rounded up, and no floating
  point anywhere. `startSample = samples(startUs)`, `endSample = samples(startUs +
durationUs)`, `sampleCount = endSample − startSample`, and `totalSamples =
samples(composition.durationUs)`. At 48 kHz an exact half cannot occur
  (`us × 48 000 − 500 000` would have to be a multiple of 1 000 000, and
  `48 × us − 500` is never a multiple of 1 000 because `12 × us` is even and
  `250 × k + 125` odd); the rule is stated so that another rate inherits it.
  The floating-point product differs from the integer rule beyond 2^52 µs
  (`4 503 599 627 370 510` µs is sample `216 172 782 113 784`, not `…785`); a
  test pins that value.
- **Graph.** `[1:a]aresample=48000,atrim=end_sample=<sampleCount>,adelay=delays=<startSample>S:all=1,apad=whole_len=<totalSamples>,atrim=end_sample=<totalSamples>,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]`:
  the clip's asset from its first sample, resampled to 48 kHz, cut to the clip,
  placed at the clip's start, padded with silence, and cut to the composition.
  The schema's audio clip has no source offset, so none is applied.
- **Bytes.** The verified bytes of the asset (D27.3), not a file, go to FFmpeg on
  a second pipe (`pipe:3`), written at the same time as the frames. Nothing is
  read again from a path.
- **Before the render**, with the pinned `ffprobe` reading the same bytes from a
  pipe: the asset must have exactly one audio stream, and it must cover the part
  of the clip that is heard,
  `audibleUs = min(durationUs, composition.durationUs − startUs)`. The length is
  **counted, not read**: a container on a pipe need not state its length
  (measured: a WAV does not, because its size is unknown there), so two `ffprobe`
  runs over the bytes give the sample rate and, with `-count_frames`, the
  `nb_samples` of every frame, summed line by line as they arrive — the length of
  an asset costs no memory. The test is
  `samples × 1 000 000 ≥ audibleUs × sample_rate` in `BigInt`. A format that
  cannot be read from a pipe (for example an MP4 with its index at the end),
  another number of audio streams, no sample rate, a shorter asset, or a clip
  that starts at or after the end of the composition (`audibleUs = 0`, which the
  schema allows) is `audio-invalid`: a missing sound is an error, and a stream of
  silence is not an export. A composition without an audio clip is exported
  without an audio stream.
- **Encoding.** `-c:a aac -b:a 128k -ar 48000 -ac 2`: stereo AAC-LC at 48 kHz.
- **Tolerance**, stated once for the checks of 29.11. The audio stream starts at
  presentation time 0, within one sample. Its length in samples is at least
  `totalSamples` and less than `totalSamples + 1024`, one AAC frame, because the
  encoder works in frames of 1 024 samples. The decoded signal has no leading
  silence and is in phase with the source within 2 samples.

**29.7 Documents of Custom HTML frames (D23.9).** The Producer records, for every
frame below the render page, the CDP loader ID and URL of its document once
before the first capture. Before and after each capture it requires:

- as many such frames as the document has Custom HTML nodes — a session is
  opened with that number, so a frame the Producer cannot see is a failure, not
  an empty check;
- each of them at `about:srcdoc`, its shell;
- each of them holding the document it held at the first frame, by loader ID.

Anything else is `custom-html-navigated`, and the frame is never delivered. This
check, not the `load` count of the renderer, is normative for reference output:
a navigated document can answer the time before its `load` reaches the render
page.

**29.8 Errors.** The codes of D28.6, plus `ffmpeg-missing`, `ffmpeg-mismatch`,
`encode-failed`, `audio-invalid`, `preset-unsupported`, and
`custom-html-navigated`. Checked before the page opens: the document, the frame
grid, the preset, the assets, FFmpeg (29.1), and the audio (29.6). A failure
after that ends the export and removes its output (29.3).

**29.9 Export manifest.** `exportMp4` returns and the CLI writes the manifest of
D28.7 (`manifestVersion` 2, which also adds `environment.network` of D28.9),
with:

- `preset`: `name` (`mp4-1080p` or `mp4-720p`), `width`, `height` of the output,
  `sourceWidth`, `sourceHeight`, `fps`, `deviceScaleFactor` 1, and the video
  graph;
- `frames`: every frame of the composition, `{ index, timeUs, sha256 }` of the
  PNG bytes FFmpeg read (29.3);
- `ffmpeg`: release, asset, URL, archive SHA-256, `ffmpegSha256`,
  `ffprobeSha256`, `version`, `configuration`, `encoders`, and `args` (29.4);
- `audio`: `null` without a clip, else `clipId`, `assetId`, `sampleRate`,
  `startSample`, `sampleCount`, `totalSamples`, `channelLayout`, `codec`,
  `bitrate`;
- `identity`: `playwrightImageDigest` (the digest of the declared image of
  D26.2 when the run is pinned, else `null`), `playwrightVersion`,
  `chromiumRevision`, `ffmpegSha256`, `ffprobeSha256`, `ffmpegVersion`, and
  `ffmpegBuildConfiguration`. It repeats values of the other fields on purpose,
  as the one block that names the environment; a test requires the two to
  agree. The image digest is declared by the container command, which checks it
  against Docker's `RepoDigests` before the run (29.11); the Producer cannot
  measure it from inside.
- `blockedRequests` as in D28.1. No wall-clock value, as in D28.7.

**29.10 CLI.** `kadrion export --composition <file> --assets <file> --out <dir>
--preset <1080p|720p> [--ffmpeg <path>] [--ffprobe <path>]` writes
`video-<preset>.mp4` and `video-<preset>.render-manifest.json` into `<dir>`.
Without the flags it takes `KADRION_FFMPEG` and `KADRION_FFPROBE`; with neither,
it fails with `ffmpeg-missing`. It never searches `PATH`. The exit codes of D28.8:
a `--preset` that is not a bare name (`[0-9a-z]+`, so it can never name a path)
is a usage error, exit 2, while a name the Producer does not support is
`preset-unsupported`, exit 1.

**29.11 Reference run (D28.9).** `tests/pinned/container/pinned-run.sh` is the
one procedure, from Git Bash or Linux:

1. pull the image of D26.2 by digest and refuse to go on unless its
   `RepoDigests` contains exactly `mcr.microsoft.com/playwright@<digest of D26.2>`;
2. fetch and verify FFmpeg (29.1) on the host;
3. prepare a volume with a copy of the working tree and
   `corepack pnpm install --frozen-lockfile` (with a network);
4. run everything else in containers with `--network none`, FFmpeg mounted
   read-only, and results on a separate writable mount, in this order:
   `corepack pnpm run check`; `node --run test:pinned` **against the golden
   frames of the working tree**, which is the pass a regression fails;
   `node --run goldens:update`; `node --run test:pinned` once more, which proves
   only what was just written; and `kadrion export` for both presets from inputs
   prepared beforehand on a read-only mount, in a container whose root file
   system is read-only with a small `tmpfs` for `/tmp`;
5. repeat the golden render in a fresh container and require identical PNG
   hashes.

## Alternatives considered

- **Raw RGBA frames** — `Page.captureScreenshot` produces no raw pixels
  (evidence 3); decoding PNG in Node.js would add a dependency and move the
  pixel-format decision out of FFmpeg.
- **One file per frame and FFmpeg's `image2` demuxer** — excluded by §8 and P5.
- **FFmpeg from Ubuntu's archive in a derived image** — the owner chose a
  checksum-pinned static build that leaves the image of D26.2 unchanged.
- **libopenh264 in an LGPL build** — the owner chose libx264.
- **A second render at device scale factor 2/3 for 720p** — changes the
  rasterisation of text, and would double the golden frames (Q2).
- **Stream copy of the audio** — cannot cut an arbitrary source at a sample.
- **The Chromium flag `--force-webrtc-ip-handling-policy`** — not a boundary
  (D28.9).
- **Pixel gates on the decoded MP4** — the owner kept pixel comparisons on the
  pre-encode frames; decoded frames are reported only. The receipt of 29.3 and
  the timestamp checks close the gaps a pixel gate would have closed.

## Consequences

- `@kadrion/producer` spawns FFmpeg (`node:child_process`) and gains
  `exportMp4`; `@kadrion/cli` gains `kadrion export`. No new package dependency;
  D12 is unchanged.
- `exportMp4` runs only in the pinned container, where the pinned binaries run;
  on the Windows development machine the export tests are skipped with a
  message, and P5 is proven only by the container run.
- A new FFmpeg build is a change of the constants of 29.1, the checksums, and
  this ADR together.
- Distributing FFmpeg is out of scope and needs 29.2 first.

## Verification

- `packages/producer/test` (Node, no browser, no FFmpeg): the argument lists of
  both presets and the absence of any image output or file pattern; the document
  check of 29.7 as a pure function (too few or too many frames, a document that
  is not the shell, a document that changed, and the count of Custom HTML nodes
  of a composition); the refusal of golden frames outside the pinned, isolated
  environment (D26.5, D28.9); the presentation times of the self-check; the sample
  arithmetic, including exact halves; the verification order of 29.1 on fake
  executables; the frame sink with a stream that never accepts a write (the
  Producer renders at most `FRAMES_IN_FLIGHT + 1` frames and fails with
  `encode-failed`); the export on a fake session and a fake encoder (frame order,
  in-flight bound, bytes and hashes, receipt mismatch, errors before the first
  frame, removal of the output, the process killed); memory with large
  synthetic frames.
- `packages/cli/test`: the arguments of `kadrion export`, the fallback to the
  environment, and never `PATH`.
- `tests/pinned/export.pinned.test.ts` (pinned container; skipped with a message
  where `KADRION_FFMPEG` is not set, failing when the run is pinned): `ffprobe`
  of both presets (streams, codec, profile, pixel format, size, SAR 1:1, 30/1,
  time base, 300 frames, every presentation time, colour tags, audio codec,
  rate, layout, start, and length within 29.6); the export's 300 hashes equal a
  `renderFrames` of the full grid and, where they exist, the golden frames; the
  `720p` export has the same 300 hashes; no file but the output appears while
  exporting; memory of a 60-frame and a 300-frame export, reported; the audio
  decoded and checked against 29.6; the decoded video against the pre-encode
  frames, reported only; typed errors before the first frame.

## Measurements

From the reference run of 29.11 on 2026-09-22: the pinned container of D26.2
(RepoDigest verified before the run), `--network none`, the pinned FFmpeg
mounted read-only, Node.js v24.20.0 of the image. `node --run test:pinned`:
72 passed, 0 failed.

- **The frames FFmpeg received are the Producer's.** The receipt of 29.3 matched
  the manifest for all 300 frames of both presets, and the manifest's 300 hashes
  equal those of a `renderFrames` over the full grid in a page of its own. At
  the golden timestamps they equal the golden frames written in the same run
  (for example frame 0: `e1e8527f…ee270`). The `720p` export has exactly the
  same 300 hashes as the `1080p` export, so the smaller preset is a scaling of
  the same render (Q2).
- **Structure.** Both files: one H.264 video stream (profile High, level 40,
  `yuv420p`, SAR 1:1, `30/1` in `r_frame_rate` and `avg_frame_rate`, time base
  `1/15360`, 300 frames counted, presentation times `0, 512, …, 153 088`) and
  one AAC-LC audio stream (48 000 Hz, stereo). 1080x1920 and 720x1280. No
  `creation_time` and no encoder tag.
- **Colour.** The stream carries the matrix (`bt709`) and the range (`tv`);
  `ffprobe` reports no primaries or transfer characteristics, with or without
  `+bitexact` (29.4).
- **Audio.** Decoded: 480 256 samples for 480 000 asked (one AAC frame is 1 024),
  no leading silence (peak 6 046 of ±8 000 in the first 10 ms), and in phase with
  the generated tone at lag 0 samples.
- **Streaming.** No file but the MP4 appeared in the output directory, the
  temporary directory, or `/dev/shm` while exporting; at most 2 frames were ever
  in flight; 300 frames were written once each. The `kadrion export` run of
  29.11, in a container with a read-only root file system and a 48 MB `tmpfs`
  for `/tmp`, used 256 KB of it — 300 PNG frames are about 10 MB — and wrote
  only `video-1080p.mp4` (744 KB), `video-720p.mp4` (721 KB), and their
  manifests.
- **Memory.** Peak live memory of Node.js was 74.1 MB for a 60-frame export and
  73.8 MB for a 300-frame export; FFmpeg's `VmHWM` was 424 MB and 432 MB. Five
  times the frames cost no memory (report only; the bounded guard is the unit
  test with 4 MB frames).
- **Decoded video (report only, P5).** Against the pre-encode frames the decoded
  MP4 gave 42.1–42.7 dB PSNR at the five golden timestamps, while the same
  decoded frames against their neighbours gave 26.4–31.3 dB: every frame is far
  closer to its own reference than to the next one.
- **Typed errors.** Before the first frame, with the real binaries: a bare name
  and a missing path are `ffmpeg-missing`; `ffprobe` passed as `ffmpeg` is
  `ffmpeg-mismatch`; a five-second asset under a ten-second clip is
  `audio-invalid`. No output file was left behind in any of them.
- **A navigated element (29.7, D23.9).** An element that navigates on the
  acknowledgement of frame 299 ends the export with `custom-html-navigated`, and
  the partial MP4 is removed.
- **Repeatability.** The golden frames of a second pass in a fresh container have
  the same five SHA-256 values as the first, and the runtime build hash is the
  same in both (`sha256:b54743b4…5115`).
