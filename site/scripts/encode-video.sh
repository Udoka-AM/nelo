#!/usr/bin/env bash
# Encode each screen recording in media-src/ into what the site streams:
#
#   public/media/<clip>/master.m3u8   HLS, three renditions; the player picks by bandwidth (ABR)
#   public/media/<clip>/<clip>.mp4    one progressive rendition, for browsers with neither
#                                     native HLS nor Media Source Extensions, and with no JS
#   public/media/<clip>/poster.{webp,jpg}  the frame shown before, or instead of, the video
#
# The recordings are the real apps, rendered in a browser (react-native-web) with
# the phone-only modules stood in for. See site/README.md.
#
#   FFMPEG=/path/to/ffmpeg site/scripts/encode-video.sh
set -euo pipefail
FFMPEG=${FFMPEG:-ffmpeg}
cd "$(dirname "$0")/.."

# clip  start(s)  poster-at(s)
while read -r clip start poster; do
  src="media-src/$clip.webm"
  out="public/media/$clip"
  rm -rf "$out" && mkdir -p "$out"

  # Two-second GOPs, aligned across renditions, so a switch can happen at any segment.
  x264=(-c:v libx264 -profile:v high -preset slow -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 -an)
  "$FFMPEG" -nostdin -v error -y -ss "$start" -i "$src" \
    -filter_complex "[0:v]split=3[a][b][c];[a]scale=360:-2[v1];[b]scale=540:-2[v2];[c]scale=720:-2[v3]" \
    -map "[v1]" -map "[v2]" -map "[v3]" "${x264[@]}" \
    -b:v:0 260k -maxrate:v:0 320k -bufsize:v:0 520k \
    -b:v:1 600k -maxrate:v:1 740k -bufsize:v:1 1200k \
    -b:v:2 1100k -maxrate:v:2 1350k -bufsize:v:2 2200k \
    -f hls -hls_time 2 -hls_playlist_type vod -hls_flags independent_segments \
    -hls_segment_type mpegts -hls_segment_filename "$out/v%v/seg%02d.ts" \
    -master_pl_name master.m3u8 -var_stream_map "v:0 v:1 v:2" "$out/v%v/index.m3u8"

  "$FFMPEG" -nostdin -v error -y -ss "$start" -i "$src" -vf scale=540:-2 "${x264[@]}" -crf 26 -maxrate 700k -bufsize 1400k \
    -movflags +faststart "$out/$clip.mp4"

  "$FFMPEG" -nostdin -v error -y -ss "$poster" -i "$src" -frames:v 1 -vf scale=540:-2 -c:v libwebp -quality 82 "$out/poster.webp"
  "$FFMPEG" -nostdin -v error -y -ss "$poster" -i "$src" -frames:v 1 -vf scale=540:-2 -q:v 4 "$out/poster.jpg"
  echo "$clip: $(du -sh "$out" | cut -f1)"
done <<'CLIPS'
merchant-sale 1.0 12.8
payer-pay 1.0 9.6
CLIPS
