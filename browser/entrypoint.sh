#!/bin/sh
set -eu

case "${ACOB_BROWSER_VNC_ENABLED:-false}" in
  true|false) ;;
  *)
    echo "error: ACOB_BROWSER_VNC_ENABLED must be true or false" >&2
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

extension_dir=/opt/acob-extension
bundled_settings="${extension_dir}/settings.json"
json_override=""
if [ -n "${ACOB_EXTENSION_SETTINGS:-}" ]; then
  if [ ! -f "$bundled_settings" ]; then
    echo "error: bundled extension settings not found at $bundled_settings" >&2
    exit 1
  fi
  if ! printf '%s' "$ACOB_EXTENSION_SETTINGS" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo "error: ACOB_EXTENSION_SETTINGS must be a JSON object" >&2
    exit 1
  fi
  json_override="$ACOB_EXTENSION_SETTINGS"
fi

# Per-setting overrides. Each ACOB_EXTENSION_<SETTING> wins over the
# ACOB_EXTENSION_SETTINGS JSON object. Empty means unset (compose passes an
# empty default when the variable is not set).
env_overrides_file="$(mktemp)"
printf '{}' >"$env_overrides_file"
add_string_override() {
  override_key="$1"
  override_value="$2"
  tmp_override="$(mktemp)"
  if ! jq --arg k "$override_key" --arg v "$override_value" \
    '. + {($k): $v}' "$env_overrides_file" >"$tmp_override"; then
    echo "error: could not apply $override_key override" >&2
    rm -f "$tmp_override" "$env_overrides_file"
    exit 1
  fi
  cat "$tmp_override" >"$env_overrides_file"
  rm -f "$tmp_override"
}
add_json_override() {
  override_key="$1"
  override_json_value="$2"
  override_env_name="$3"
  tmp_override="$(mktemp)"
  if ! jq --arg k "$override_key" --argjson v "$override_json_value" \
    '. + {($k): $v}' "$env_overrides_file" >"$tmp_override"; then
    echo "error: could not apply $override_env_name override" >&2
    rm -f "$tmp_override" "$env_overrides_file"
    exit 1
  fi
  cat "$tmp_override" >"$env_overrides_file"
  rm -f "$tmp_override"
}
add_boolean_override() {
  override_key="$1"
  override_value="$2"
  override_env_name="$3"
  case "$override_value" in
    true|false) ;;
    *)
      echo "error: $override_env_name must be true or false" >&2
      rm -f "$env_overrides_file"
      exit 1
      ;;
  esac
  add_json_override "$override_key" "$override_value" "$override_env_name"
}
add_integer_override() {
  override_key="$1"
  override_value="$2"
  override_env_name="$3"
  stripped_value="${override_value#-}"
  case "$stripped_value" in
    ''|*[!0-9]*)
      echo "error: $override_env_name must be an integer" >&2
      rm -f "$env_overrides_file"
      exit 1
      ;;
  esac
  add_json_override "$override_key" "$override_value" "$override_env_name"
}
if [ -n "${ACOB_EXTENSION_BASE_URL:-}" ]; then
  add_string_override "baseUrl" "$ACOB_EXTENSION_BASE_URL"
fi
if [ -n "${ACOB_EXTENSION_ALLOW_CLEANUP:-}" ]; then
  add_boolean_override "allowCleanup" "$ACOB_EXTENSION_ALLOW_CLEANUP" "ACOB_EXTENSION_ALLOW_CLEANUP"
fi
if [ -n "${ACOB_EXTENSION_INSTRUCTIONS_PER_POLL:-}" ]; then
  add_integer_override "instructionsPerPoll" "$ACOB_EXTENSION_INSTRUCTIONS_PER_POLL" "ACOB_EXTENSION_INSTRUCTIONS_PER_POLL"
fi
if [ -n "${ACOB_EXTENSION_MAX_CONCURRENT_EXECUTIONS:-}" ]; then
  add_integer_override "maxConcurrentExecutions" "$ACOB_EXTENSION_MAX_CONCURRENT_EXECUTIONS" "ACOB_EXTENSION_MAX_CONCURRENT_EXECUTIONS"
fi
if [ -n "${ACOB_EXTENSION_MAX_TABS:-}" ]; then
  add_integer_override "maxTabs" "$ACOB_EXTENSION_MAX_TABS" "ACOB_EXTENSION_MAX_TABS"
fi
if [ -n "${ACOB_EXTENSION_POLL_INTERVAL_MS:-}" ]; then
  add_integer_override "pollIntervalMs" "$ACOB_EXTENSION_POLL_INTERVAL_MS" "ACOB_EXTENSION_POLL_INTERVAL_MS"
fi
if [ -n "${ACOB_EXTENSION_TAB_LOAD_TIMEOUT_MS:-}" ]; then
  add_integer_override "tabLoadTimeoutMs" "$ACOB_EXTENSION_TAB_LOAD_TIMEOUT_MS" "ACOB_EXTENSION_TAB_LOAD_TIMEOUT_MS"
fi
if [ -n "${ACOB_EXTENSION_HTTP_REQUEST_TIMEOUT_MS:-}" ]; then
  add_integer_override "httpRequestTimeoutMs" "$ACOB_EXTENSION_HTTP_REQUEST_TIMEOUT_MS" "ACOB_EXTENSION_HTTP_REQUEST_TIMEOUT_MS"
fi
if [ -n "${ACOB_EXTENSION_JAVASCRIPT_TIMEOUT_MS:-}" ]; then
  add_integer_override "javascriptTimeoutMs" "$ACOB_EXTENSION_JAVASCRIPT_TIMEOUT_MS" "ACOB_EXTENSION_JAVASCRIPT_TIMEOUT_MS"
fi
if [ -n "${ACOB_EXTENSION_MAX_SCREENSHOT_SIZE_MIB:-}" ]; then
  add_integer_override "maxScreenshotSizeMiB" "$ACOB_EXTENSION_MAX_SCREENSHOT_SIZE_MIB" "ACOB_EXTENSION_MAX_SCREENSHOT_SIZE_MIB"
fi
if [ -n "${ACOB_EXTENSION_MAX_RECORDING_DURATION_SEC:-}" ]; then
  add_integer_override "maxRecordingDurationSec" "$ACOB_EXTENSION_MAX_RECORDING_DURATION_SEC" "ACOB_EXTENSION_MAX_RECORDING_DURATION_SEC"
fi
if [ -n "${ACOB_EXTENSION_MAX_RECORDING_SIZE_MIB:-}" ]; then
  add_integer_override "maxRecordingSizeMiB" "$ACOB_EXTENSION_MAX_RECORDING_SIZE_MIB" "ACOB_EXTENSION_MAX_RECORDING_SIZE_MIB"
fi
if [ -n "${ACOB_EXTENSION_CONSOLE_TIMEOUT_SEC:-}" ]; then
  add_integer_override "consoleTimeoutSec" "$ACOB_EXTENSION_CONSOLE_TIMEOUT_SEC" "ACOB_EXTENSION_CONSOLE_TIMEOUT_SEC"
fi
if [ -n "${ACOB_EXTENSION_CONSOLE_MAX_SIZE_MIB:-}" ]; then
  add_integer_override "consoleMaxSizeMiB" "$ACOB_EXTENSION_CONSOLE_MAX_SIZE_MIB" "ACOB_EXTENSION_CONSOLE_MAX_SIZE_MIB"
fi
if [ -n "${ACOB_EXTENSION_RESULT_RETRY_ATTEMPTS:-}" ]; then
  add_integer_override "resultRetryAttempts" "$ACOB_EXTENSION_RESULT_RETRY_ATTEMPTS" "ACOB_EXTENSION_RESULT_RETRY_ATTEMPTS"
fi
if [ -n "${ACOB_EXTENSION_RESULT_RETRY_DELAY_MS:-}" ]; then
  add_integer_override "resultRetryDelayMs" "$ACOB_EXTENSION_RESULT_RETRY_DELAY_MS" "ACOB_EXTENSION_RESULT_RETRY_DELAY_MS"
fi
if [ -n "${ACOB_EXTENSION_POPUP_STATUS_DURATION_MS:-}" ]; then
  add_integer_override "popupStatusDurationMs" "$ACOB_EXTENSION_POPUP_STATUS_DURATION_MS" "ACOB_EXTENSION_POPUP_STATUS_DURATION_MS"
fi
if [ -n "${ACOB_EXTENSION_DEBUGGER_PROTOCOL_VERSION:-}" ]; then
  add_string_override "debuggerProtocolVersion" "$ACOB_EXTENSION_DEBUGGER_PROTOCOL_VERSION"
fi
if [ -n "$json_override" ] || [ "$(cat "$env_overrides_file")" != "{}" ]; then
  if [ ! -f "$bundled_settings" ]; then
    echo "error: bundled extension settings not found at $bundled_settings" >&2
    rm -f "$env_overrides_file"
    exit 1
  fi
  tmp_json_override="$(mktemp)"
  tmp_settings="$(mktemp)"
  if [ -n "$json_override" ]; then
    printf '%s' "$json_override" >"$tmp_json_override"
  else
    printf '{}' >"$tmp_json_override"
  fi
  if ! jq -s '.[0] * .[1] * .[2]' \
    "$bundled_settings" "$tmp_json_override" "$env_overrides_file" >"$tmp_settings"; then
    echo "error: could not merge extension settings overrides over bundled settings" >&2
    rm -f "$tmp_json_override" "$tmp_settings" "$env_overrides_file"
    exit 1
  fi
  cat "$tmp_settings" >"$bundled_settings"
  rm -f "$tmp_json_override" "$tmp_settings"
  echo "Applied extension settings overrides to bundled extension settings"
fi
rm -f "$env_overrides_file"

# /data is ephemeral (no volume): every container recreate starts from a fresh
# Chromium profile, so a stale profile can never break the extension after an
# upgrade. The directory only survives stop/start of the same container.
mkdir -p /data
chown acob:acob /data
# Container recreation changes the hostname recorded in Chromium's profile lock.
# No Chromium process exists yet in this container, so these artifacts are stale.
rm -f /data/SingletonCookie /data/SingletonLock /data/SingletonSocket
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

display="${ACOB_BROWSER_DISPLAY:-:99}"
case "$display" in
  :*) ;;
  *)
    echo "error: ACOB_BROWSER_DISPLAY must be a display like :99" >&2
    exit 1
    ;;
esac
display_number="${display#:}"
case "$display_number" in
  ''|*[!0-9]*)
    echo "error: ACOB_BROWSER_DISPLAY must be a display like :99" >&2
    exit 1
    ;;
esac

gosu acob Xvfb "$display" -screen 0 "${width}x${height}x24" -nolisten tcp -ac &
xvfb_pid=$!

attempt=0
while [ ! -S "/tmp/.X11-unix/X${display_number}" ]; do
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

if [ "${ACOB_BROWSER_VNC_ENABLED:-false}" = "true" ]; then
  echo "Starting passwordless noVNC on container port 6080"
  gosu acob x11vnc \
    -display "$display" \
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
  --host-resolver-rules="MAP localhost host.docker.internal" \
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
