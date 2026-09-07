FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        gosu \
        novnc \
        procps \
        tini \
        websockify \
        x11vnc \
        xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/sh acob

COPY --from=extension / /opt/acob-extension
COPY entrypoint.sh /usr/local/bin/acob-browser

RUN chmod 0755 /usr/local/bin/acob-browser

ENV ACOB_VNC_ENABLED=false \
    DISPLAY=:99

VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD pgrep -u acob -x chromium >/dev/null \
        && { [ "$ACOB_VNC_ENABLED" != "true" ] \
        || { pgrep -u acob -x x11vnc >/dev/null \
        && pgrep -u acob -f 'websockify.*6080' >/dev/null; }; } \
        || exit 1

ENTRYPOINT ["tini", "--", "/usr/local/bin/acob-browser"]
