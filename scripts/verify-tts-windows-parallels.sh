#!/usr/bin/env bash
#
# HS-8765 — automated Windows OS-voice (Announcer TTS) verification via a
# Parallels Windows VM. Drives the EXACT .NET synthesizer the Tauri app's
# `tts_speak` uses on Windows (`System.Speech.Synthesis.SpeechSynthesizer`, see
# `src-tauri/src/lib.rs::build_tts_command`), redirected to a wav via
# `SetOutputToWaveFile`, copies the wav back to the host (base64 over
# `prlctl exec`), and checks it is NOT silent.
#
# This is the maintainer's "save to a wav and check it's not silent" idea made
# re-runnable. It does NOT need the Tauri Rust toolchain in the guest — it runs
# only the System.Speech command the app spawns. Requirements on the host:
# Parallels (`prlctl`) with a Windows VM + ffmpeg. NOT wired into CI.
#
# Usage:  scripts/verify-tts-windows-parallels.sh ["VM name"]   (default: "Windows 11")
# Exit 0 = PASS (non-silent audio), non-zero = FAIL.
set -euo pipefail

VM="${1:-Windows 11}"
GUEST_WAV='C:\Windows\Temp\hs_tts_win.wav'
PEAK_THRESHOLD_DB=-30
OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT

command -v prlctl >/dev/null || { echo "FAIL: prlctl not found (Parallels)"; exit 1; }
command -v ffmpeg >/dev/null || { echo "FAIL: ffmpeg not found (brew install ffmpeg)"; exit 1; }

# Resume the VM if it isn't already running (and remember so we can re-suspend).
WAS_RUNNING=1
if ! prlctl list 2>/dev/null | grep -q "running .* ${VM}$"; then
  WAS_RUNNING=0
  echo "Resuming VM '${VM}'…"
  prlctl resume "$VM" >/dev/null 2>&1 || prlctl start "$VM" >/dev/null 2>&1
  sleep 8
fi

echo "Synthesizing via System.Speech in the guest…"
prlctl exec "$VM" powershell -NoProfile -Command \
  "Add-Type -AssemblyName System.Speech; \$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \$s.SetOutputToWaveFile('${GUEST_WAV//\\/\\\\}'); \$s.Speak('Hot Sheet announcer test, one two three.'); \$s.Dispose(); Write-Output ('SIZE=' + (Get-Item '${GUEST_WAV//\\/\\\\}').Length)"

echo "Copying the wav back to the host…"
prlctl exec "$VM" powershell -NoProfile -Command \
  "[Convert]::ToBase64String([IO.File]::ReadAllBytes('${GUEST_WAV//\\/\\\\}'))" \
  | tr -d '\r\n' > "$OUT/win.b64"
base64 -D -i "$OUT/win.b64" -o "$OUT/win.wav"
[ -s "$OUT/win.wav" ] || { echo "FAIL: empty wav returned from guest"; exit 1; }

PEAK="$(ffmpeg -hide_banner -i "$OUT/win.wav" -af volumedetect -f null /dev/null 2>&1 \
  | sed -n 's/.*max_volume: \(-*[0-9.]*\) dB/\1/p')"
echo "System.Speech recording peak: ${PEAK:-none} dBFS (threshold ${PEAK_THRESHOLD_DB})"

# Best-effort: clean the guest temp + restore the VM to its prior state.
prlctl exec "$VM" cmd /c "del ${GUEST_WAV}" >/dev/null 2>&1 || true
if [ "$WAS_RUNNING" -eq 0 ]; then prlctl suspend "$VM" >/dev/null 2>&1 || true; fi

[ -n "$PEAK" ] || { echo "FAIL: could not read a volume level (silent / no audio)"; exit 1; }
awk -v p="$PEAK" -v t="$PEAK_THRESHOLD_DB" 'BEGIN{ exit !(p > t) }' \
  || { echo "FAIL: audio too quiet — likely silent"; exit 1; }
echo "PASS: Windows System.Speech produced non-silent audio."
