#!/usr/bin/env bash
#
# HS-8765 — automated Linux OS-voice (Announcer TTS) verification, headless, via
# Docker. Exercises the EXACT command the Tauri app's `tts_speak` spawns on Linux
# (`spd-say --wait`, see `src-tauri/src/lib.rs::build_tts_command`) end-to-end:
# spd-say -> speech-dispatcher -> espeak-ng -> PulseAudio null sink, recorded to a
# wav, then checks the wav is NOT silent and that no `spd-say` children linger
# after `--wait` completes (the orphan concern).
#
# This is the maintainer's idea ("save to a wav and check it's not empty/silent")
# made re-runnable. It needs Docker running + ffmpeg on the host (macOS: `brew
# install ffmpeg`). It is NOT wired into CI — it's an on-demand desktop check
# (containers have no real audio device; this captures the synthesized audio off
# a virtual sink, which is exactly what would have been played).
#
# Usage:  scripts/verify-tts-linux-docker.sh
# Exit 0 = PASS (non-silent audio produced, no orphans), non-zero = FAIL.
set -euo pipefail

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
# Peak louder than this (dBFS) counts as real speech; pure silence is ~ -91 dB
# (or volumedetect reports no/`-inf` mean). Speech here peaks around -2 dB.
PEAK_THRESHOLD_DB=-30

command -v docker >/dev/null || { echo "FAIL: docker not found / not running"; exit 1; }
command -v ffmpeg >/dev/null || { echo "FAIL: ffmpeg not found (brew install ffmpeg)"; exit 1; }

cat >"$OUT/run.sh" <<'INNER'
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq speech-dispatcher espeak-ng pulseaudio pulseaudio-utils >/dev/null 2>&1
useradd -m tts
cat >/home/tts/inner.sh <<'EOS'
set -e
export XDG_RUNTIME_DIR=/tmp/ttsrt; mkdir -p "$XDG_RUNTIME_DIR"
pulseaudio --start --exit-idle-time=-1 -n \
  --load="module-null-sink sink_name=hs_null" \
  --load="module-native-protocol-unix" --log-target=stderr 2>/dev/null || true
sleep 1
pactl set-default-sink hs_null 2>/dev/null || true
mkdir -p ~/.config/speech-dispatcher
printf 'AudioOutputMethod "pulse"\nDefaultModule espeak-ng\n' > ~/.config/speech-dispatcher/speechd.conf
parec -d hs_null.monitor --file-format=wav /out/spdsay.wav 2>/dev/null &
PAREC=$!
sleep 0.5
spd-say --wait "Hot Sheet announcer test through speech dispatcher."
sleep 0.5
kill "$PAREC" 2>/dev/null || true
sleep 0.3
if pgrep spd-say >/dev/null 2>&1; then echo "ORPHANS=YES"; else echo "ORPHANS=NONE"; fi
EOS
su tts -c 'bash /home/tts/inner.sh'
INNER

echo "Running the Linux TTS stack in a container (first run installs packages)…"
docker run --rm -v "$OUT:/out" ubuntu:24.04 bash /out/run.sh | tee "$OUT/log.txt"

[ -s "$OUT/spdsay.wav" ] || { echo "FAIL: spd-say produced no recording"; exit 1; }
grep -q "ORPHANS=NONE" "$OUT/log.txt" || { echo "FAIL: orphaned spd-say process(es) lingered"; exit 1; }

PEAK="$(ffmpeg -hide_banner -i "$OUT/spdsay.wav" -af volumedetect -f null /dev/null 2>&1 \
  | sed -n 's/.*max_volume: \(-*[0-9.]*\) dB/\1/p')"
echo "spd-say recording peak: ${PEAK:-none} dBFS (threshold ${PEAK_THRESHOLD_DB})"
[ -n "$PEAK" ] || { echo "FAIL: could not read a volume level (silent / no audio)"; exit 1; }
awk -v p="$PEAK" -v t="$PEAK_THRESHOLD_DB" 'BEGIN{ exit !(p > t) }' \
  || { echo "FAIL: audio too quiet — likely silent"; exit 1; }

echo "PASS: spd-say produced non-silent audio and left no orphaned processes."
