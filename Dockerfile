FROM node:24-bookworm

# System dependencies (tmux: the daemon fetches a verified static build into
# ~/.brane/bin when it starts)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    gnupg \
    gosu \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Tailscale (sole network access mechanism)
RUN curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg | \
    gpg --dearmor -o /usr/share/keyrings/tailscale-archive-keyring.gpg && \
    curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list | \
    tee /etc/apt/sources.list.d/tailscale.list && \
    apt-get update && apt-get install -y --no-install-recommends tailscale && \
    rm -rf /var/lib/apt/lists/*

# Claude Code CLI. Its postinstall copies the native binary over the
# `claude` placeholder, and npm 11 skips a global package's install scripts
# unless they're allowed, so run it explicitly; `claude --version` fails the
# build if the placeholder is still there.
RUN npm i -g @anthropic-ai/claude-code && \
    node "$(npm root -g)/@anthropic-ai/claude-code/install.cjs" && \
    claude --version

# Brane (from pre-built tarball in the build context)
COPY brane-*.tgz /tmp/
RUN npm i -g /tmp/brane-*.tgz

# Non-root user for running the daemon and spawned agents
RUN useradd -m -s /bin/bash brane && \
    mkdir -p /home/brane/.brane/bin /home/brane/workspace && \
    cp /root/.brane/bin/tmux /home/brane/.brane/bin/tmux 2>/dev/null || true && \
    chown -R brane:brane /home/brane/.brane /home/brane/workspace

# Pre-download embedding model into image layer (outside ~/.brane volume),
# with brane's own loader: the files land exactly where the daemon looks
# (BRANE_MODEL_CACHE), and one embedding is run, so a broken download fails
# the build rather than the first search.
ENV BRANE_MODEL_CACHE=/opt/brane/models
RUN mkdir -p /opt/brane/models && \
    node --input-type=module \
      -e 'const { createEmbedder } = await import(process.argv[1]); const e = await createEmbedder(); const [v] = await e.embed(["warm"]); await e.dispose(); if (v.length !== 384) throw new Error("unexpected vector"); console.log("Model cached.")' \
      "$(npm root -g)/brane/dist/memory/embedder.js" && \
    chown -R brane:brane /opt/brane

# Entrypoint (starts as root for tailscaled, drops to brane user)
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Persist home directory across container restarts (brane data, cargo, etc.)
VOLUME /home/brane

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD gosu brane brane daemon status || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
