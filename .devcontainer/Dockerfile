FROM mcr.microsoft.com/devcontainers/javascript-node:5-26-bookworm

ARG BUN_VERSION=1.4.3
ARG OPENCODE1_VERSION=1.19.2
ARG OPENCODE2_VERSION=2.0.30

# Both opencode packages install an `opencode` command, so each gets its own prefix;
# oc1 and oc2 pick the right one.
RUN npm install -g bun@${BUN_VERSION} \
 && npm install -g --prefix /opt/opencode1 opencode-ai@${OPENCODE1_VERSION} \
 && npm install -g --prefix /opt/opencode2 @opencode/cli@${OPENCODE2_VERSION} \
 && npm cache clean --force

# No browser in the container: Copilot's device login prints the URL instead.
RUN printf '#!/bin/sh\necho "open in your browser: $*" >&2\n' > /usr/local/bin/xdg-open \
 && chmod +x /usr/local/bin/xdg-open

COPY bin/ /usr/local/bin/

# Logins, sessions and plugin logs of both opencode versions; a volume keeps them
# across rebuilds.
RUN mkdir -p /home/node/.oc && chown node:node /home/node/.oc
