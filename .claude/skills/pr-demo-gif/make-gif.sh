#!/usr/bin/env bash
# Turn a raw screencast into a short GIF for a PR description.
#
#   make-gif.sh <in.mp4> <out.gif> [--width 960] [--fps 12] [--hold 2.2]
#
# Driving the browser through tool calls leaves long still stretches (the page
# waits while the agent thinks). Every still stretch longer than --hold seconds
# is cut down to --hold, so captions stay readable but dead time disappears.
# Needs ffmpeg and python3.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <in.mp4> <out.gif> [--width N] [--fps N] [--hold SECONDS]" >&2
  exit 2
fi
IN=$1 OUT=$2; shift 2
WIDTH=960 FPS=12 HOLD=2.2
while [ $# -gt 0 ]; do
  case $1 in
    --width) WIDTH=$2; shift 2 ;;
    --fps) FPS=$2; shift 2 ;;
    --hold) HOLD=$2; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN")
FREEZES=$(ffmpeg -hide_banner -i "$IN" -vf "freezedetect=n=0.001:d=$HOLD" -map 0:v -f null - 2>&1 \
  | grep -E 'freeze_(start|end)' | awk '{print $NF}' | tr '\n' ' ' || true)

# FREEZES is a space-separated list of numbers; split it on purpose.
# shellcheck disable=SC2086
SELECT=$(python3 -I - "$HOLD" "$DURATION" $FREEZES <<'EOF'
import sys
hold, duration = float(sys.argv[1]), float(sys.argv[2])
vals = [float(v) for v in sys.argv[3:]]
if len(vals) % 2:  # still at the very end: freeze_end never printed
    vals.append(duration)
drops = [(s + hold, e) for s, e in zip(vals[::2], vals[1::2]) if e - s > hold]
cut = '+'.join(f'between(t,{a:.3f},{b:.3f})' for a, b in drops)
print(f"select='not({cut})'," if cut else '', end='')
EOF
)

# Constant frame rate first, so dropped stretches leave no timestamp gaps.
FILTER="fps=30,${SELECT}setpts=N/FRAME_RATE/TB,fps=$FPS,scale=$WIDTH:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
ffmpeg -v error -y -i "$IN" -vf "$FILTER" "$OUT"

OUT_DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")
printf '%s: %.0fs (from %.0fs), %s\n' "$OUT" "$OUT_DURATION" "$DURATION" "$(du -h "$OUT" | cut -f1)"
