#!/bin/sh
set -eu

case "${ACOB_VNC_ENABLED:-false}" in
  true|false) ;;
  *)
    echo "error: ACOB_VNC_ENABLED must be true or false" >&2
    exit 1
    ;;
esac

for dimension in "${ACOB_BROWSER_WIDTH:-1920}" "${ACOB_BROWSER_HEIGHT:-1080}"; do
  case "$dimension" in
    ''|*[!0-9]*)
      echo "error: browser dimensions must be positive integers" >&2
      exit 1
      ;;
  esac
  if [ "$dimension" -lt 1 ]; then
    echo "error: browser dimensions must be positive integers" >&2
    exit 1
  fi
done

width=${ACOB_BROWSER_WIDTH:-1920}
height=${ACOB_BROWSER_HEIGHT:-1080}

chown acob:acob /data
# Container recreation changes the hostname recorded in Chromium's profile lock.
# No Chromium process exists yet in this container, so these artifacts are stale.
rm -f /data/SingletonCookie /data/SingletonLock /data/SingletonSocket
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

gosu acob Xvfb "$DISPLAY" -screen 0 "${width}x${height}x24" -nolisten tcp -ac &
xvfb_pid=$!

attempt=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "error: Xvfb exited before the display was ready" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ]; then
    echo "error: timed out waiting for the Xvfb display" >&2
    exit 1
  fi
  sleep 0.1
done

if [ "$ACOB_VNC_ENABLED" = "true" ]; then
  echo "Starting passwordless noVNC on container port 6080"
  gosu acob x11vnc \
    -display "$DISPLAY" \
    -forever \
    -shared \
    -nopw \
    -listen 127.0.0.1 \
    -rfbport 5900 &
  gosu acob websockify \
    --web=/usr/share/novnc \
    0.0.0.0:6080 \
    127.0.0.1:5900 &
fi

exec gosu acob chromium \
  --user-data-dir=/data \
  --no-sandbox \
  --load-extension=/opt/acob-extension \
  --disable-extensions-except=/opt/acob-extension \
  --no-first-run \
  --no-default-browser-check \
  --noerrdialogs \
  --disable-breakpad \
  --disable-crash-reporter \
  --disable-component-update \
  --disable-features=Translate \
  --password-store=basic \
  --ozone-platform=x11 \
  --window-size="${width},${height}" \
  about:blank
