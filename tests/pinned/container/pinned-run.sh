#!/usr/bin/env bash
# The reference run of D29.11 and D28.9, from Git Bash or Linux:
#
#   tests/pinned/container/pinned-run.sh [prepare|reference|repeat|all]
#
# prepare    pulls the image of D26.2 by digest and refuses any other RepoDigest,
#            fetches and verifies the pinned FFmpeg (D29.1), and fills a Docker
#            volume with a copy of the working tree and its dependencies. This is
#            the only step with a network, and it renders nothing.
# reference  runs in containers with --network none: check; test:pinned against
#            the golden frames of the working tree, whose parity record (D33.6)
#            is copied out at once; then goldens:update and
#            test:pinned once more against the frames it just wrote; and
#            `kadrion export` for both presets in a read-only container from
#            inputs on a read-only mount. The first pass is the one that can
#            fail on a regression — the second only proves what was written.
# repeat     renders the golden frames again in a fresh container and requires
#            identical hashes, then runs test:pinned against them once more.
# sync       copies the working tree into the prepared volume again, without a
#            network and without installing: for a second reference run after an
#            edit. It is a convenience of development, not part of the run.
#
# Results go to .kadrion-out/pinned-run (KADRION_RUN_OUT). Golden frames are
# copied into the working tree only at the end of `repeat`, after both passes
# succeeded with identical hashes. Nothing here falls back to the host.
set -euo pipefail

IMAGE='mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'
DIGEST_REFERENCE='mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'
FFMPEG_RELEASE='autobuild-2026-09-21-13-55'

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=${KADRION_RUN_OUT:-$ROOT/.kadrion-out/pinned-run}
VOLUME=${KADRION_RUN_VOLUME:-kadrion-pinned-work}
# pnpm, cached by Corepack while there is a network, outside the tree that check lints.
COREPACK_VOLUME=${VOLUME}-corepack
FFMPEG_BIN=$ROOT/.kadrion-cache/ffmpeg/$FFMPEG_RELEASE/bin
GOLDENS=packages/test-fixtures/src/golden-frames
PHASE=${1:-all}

# Docker Desktop on Windows takes Windows paths; Git Bash must not rewrite /work and friends.
export MSYS_NO_PATHCONV=1
host_path() { if command -v cygpath > /dev/null; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

log() { printf '[pinned-run] %s\n' "$*" >&2; }

isolated() {
  # The reference containers: no network, FFmpeg read-only, results on their own mount.
  docker run --rm --platform linux/amd64 --network none --shm-size=1g \
    -v "$VOLUME:/work" \
    -v "$(host_path "$FFMPEG_BIN"):/opt/kadrion-ffmpeg:ro" \
    -v "$(host_path "$OUT"):/out" \
    -e KADRION_PINNED_IMAGE="$IMAGE" \
    -e KADRION_FFMPEG=/opt/kadrion-ffmpeg/ffmpeg \
    -e KADRION_FFPROBE=/opt/kadrion-ffmpeg/ffprobe \
    -v "$COREPACK_VOLUME:/corepack" -e COREPACK_HOME=/corepack \
    -e COREPACK_ENABLE_NETWORK=0 \
    -e CI=1 \
    -w /work "$IMAGE" bash -o pipefail -c "$1"
}

# The copy of the working tree that the containers run, without node_modules.
copy_tree() {
  local network=$1
  docker run --rm --platform linux/amd64 $network \
    -v "$(host_path "$ROOT"):/src:ro" -v "$VOLUME:/work" \
    -v "$COREPACK_VOLUME:/corepack" -e COREPACK_HOME=/corepack -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -e CI=1 \
    -w /work "$IMAGE" bash -o pipefail -c "$2"
}

sync() {
  log "copying the working tree into the volume $VOLUME (no install)"
  copy_tree --network=none '
    tar -C /src --exclude=./.git --exclude=./node_modules --exclude="./*/*/node_modules" \
      --exclude="./*/*/dist" --exclude=./.kadrion-cache --exclude=./.kadrion-out \
      -cf - . | tar -C /work -xf -'
}

prepare() {
  log "pulling $IMAGE"
  docker pull --platform linux/amd64 "$IMAGE" > /dev/null
  local digests
  digests=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE")
  if ! grep -Fxq "$DIGEST_REFERENCE" <<< "$digests"; then
    log "refusing: RepoDigests are not $DIGEST_REFERENCE:"
    printf '%s\n' "$digests" >&2
    exit 1
  fi
  log "RepoDigest verified: $DIGEST_REFERENCE"
  (cd "$ROOT" && node --run ffmpeg:fetch)
  docker volume rm -f "$VOLUME" "$COREPACK_VOLUME" > /dev/null
  docker volume create "$VOLUME" > /dev/null
  docker volume create "$COREPACK_VOLUME" > /dev/null
  log "copying the working tree into the volume $VOLUME and installing (with a network)"
  copy_tree '' '
      tar -C /src --exclude=./.git --exclude=./node_modules --exclude="./*/*/node_modules" \
        --exclude="./*/*/dist" --exclude=./.kadrion-cache --exclude=./.kadrion-out \
        -cf - . | tar -C /work -xf -
      # The store stays outside the tree: check lints and formats everything in /work.
      corepack pnpm install --frozen-lockfile --store-dir /pnpm-store
      corepack pnpm --version'
}

reference() {
  rm -rf "$OUT"
  mkdir -p "$OUT/inputs" "$OUT/cli"
  log "reference run with --network none"
  isolated '
    set -e
    { echo "interfaces: $(ls /sys/class/net | tr "\n" " ")"; cat /proc/net/dev; } > /out/network-before.txt
    node --version > /out/node-version.txt
    sha256sum /opt/kadrion-ffmpeg/ffmpeg /opt/kadrion-ffmpeg/ffprobe > /out/ffmpeg-sha256.txt
    corepack pnpm run check 2>&1 | tee /out/check.log
    # First against the golden frames of the working tree: a regression fails here.
    node --run test:pinned 2>&1 | tee /out/test-pinned-1.log
    # The Kadrion-owned summary of that run, from its raw Vitest report (PR-13),
    # kept beside that report. Every pass below writes its own summary too, so the
    # copies of .kadrion-out never pair a report with the summary of another pass.
    # ci-identity.json needs GITHUB_* and a .git checkout, so only CI writes it.
    node --experimental-strip-types tests/ci/write-pinned-summary.ts 2>&1 | tee /out/pinned-summary-1.log
    cp .kadrion-out/vitest-pinned.json /out/vitest-pinned-1.json
    cp .kadrion-out/pinned-test-summary.json /out/pinned-test-summary-1.json
    # The parity record of D33 measured against the committed golden frames, before
    # goldens:update can rewrite them: this is the record docs/spike keeps (D33.6).
    cp .kadrion-out/parity/parity-measurement.json /out/parity-measurement-1.json
    node --run goldens:update 2>&1 | tee /out/goldens-update-1.log
    cp -r '"$GOLDENS"' /out/goldens-1
    node --run test:pinned 2>&1 | tee /out/test-pinned-2.log
    node --experimental-strip-types tests/ci/write-pinned-summary.ts 2>&1 | tee /out/pinned-summary-2.log
    node --experimental-strip-types tests/pinned/write-inputs.ts /out/inputs
    cp -r .kadrion-out /out/kadrion-out-1
    cat /proc/net/dev > /out/network-after.txt'
  log "kadrion export in a read-only container from read-only inputs"
  docker run --rm --platform linux/amd64 --network none --read-only \
    --tmpfs /tmp:rw,size=48m --shm-size=1g \
    -v "$VOLUME:/work:ro" \
    -v "$(host_path "$OUT/inputs"):/inputs:ro" \
    -v "$(host_path "$FFMPEG_BIN"):/opt/kadrion-ffmpeg:ro" \
    -v "$(host_path "$OUT/cli"):/cli" \
    -e HOME=/tmp -e KADRION_PINNED_IMAGE="$IMAGE" \
    -e KADRION_FFMPEG=/opt/kadrion-ffmpeg/ffmpeg -e KADRION_FFPROBE=/opt/kadrion-ffmpeg/ffprobe \
    -w /work "$IMAGE" bash -o pipefail -c '
      set -e
      for preset in 1080p 720p; do
        node packages/cli/dist/bin.js export --composition /inputs/composition.json \
          --assets /inputs/assets.json --out /cli --preset "$preset" 2>&1 | tee -a /cli/export.log
      done
      ls -la /cli > /cli/listing.txt
      df -k /tmp > /cli/tmp-usage.txt
      /opt/kadrion-ffmpeg/ffprobe -v error -show_streams -show_format -of json /cli/video-1080p.mp4 > /cli/ffprobe-1080p.json
      /opt/kadrion-ffmpeg/ffprobe -v error -show_streams -show_format -of json /cli/video-720p.mp4 > /cli/ffprobe-720p.json'
}

repeat() {
  log "second pass in a fresh container: the golden frames again"
  isolated '
    set -e
    node --run goldens:update 2>&1 | tee /out/goldens-update-2.log
    cp -r '"$GOLDENS"' /out/goldens-2
    node --run test:pinned 2>&1 | tee /out/test-pinned-3.log
    node --experimental-strip-types tests/ci/write-pinned-summary.ts 2>&1 | tee /out/pinned-summary-3.log
    cp -r .kadrion-out /out/kadrion-out-2'
  local first second
  first=$(cd "$OUT/goldens-1" && sha256sum -- *.png)
  second=$(cd "$OUT/goldens-2" && sha256sum -- *.png)
  if [ "$first" != "$second" ]; then
    log "the golden frames differ between the passes:"
    diff <(printf '%s\n' "$first") <(printf '%s\n' "$second") >&2 || true
    exit 1
  fi
  printf '%s\n' "$first" > "$OUT/goldens-repeatability.txt"
  log "the golden frames are identical in both passes: copying them into the working tree"
  rm -rf "${ROOT:?}/$GOLDENS"
  cp -r "$OUT/goldens-1" "$ROOT/$GOLDENS"
}

case "$PHASE" in
  prepare) prepare ;;
  sync) sync ;;
  reference) reference ;;
  repeat) repeat ;;
  # Sequentially, not with &&: bash suppresses errexit inside a function of an && list.
  all)
    prepare
    reference
    repeat
    ;;
  *) log "unknown phase $PHASE" && exit 2 ;;
esac
