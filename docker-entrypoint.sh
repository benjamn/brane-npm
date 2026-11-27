#!/bin/bash
set -e

# The wake door, first of all: a separate process on its own port (WAKE_PORT,
# 8080), answering GET /wake with which machine this is (200, JSON) and
# everything else with 404. Fly Proxy
# starts a stopped machine when a request arrives for fly.toml's
# [http_service], and this is the port that service routes to, so it comes up
# before anything slow (the volume chown, tailscaled) and the request that
# woke the machine is answered as soon as the container is. It is never the
# daemon's port: the daemon below has no IP filter, and nothing of it is
# behind this listener. Exiting the daemon stops the machine and this with it.
WAKE_PORT="${WAKE_PORT:-8080}"
export WAKE_PORT
gosu brane node "$(npm root -g)/brane/dist/fly/wake-listener.js" &

# Volume is mounted at /home/brane (the entire home directory).
# Migrate from old layout where volume was mounted at /home/brane/.brane
# and contained brane.db at the volume root.
if [ -f /home/brane/brane.db ] && [ ! -d /home/brane/.brane/db ]; then
    echo "Migrating volume layout: moving contents into .brane/ subdirectory..."
    mkdir -p /home/brane/.brane
    # Move everything except .brane itself into .brane/
    for f in /home/brane/*; do
        [ "$(basename "$f")" = ".brane" ] && continue
        mv "$f" /home/brane/.brane/
    done
    for f in /home/brane/.[!.]* /home/brane/..?*; do
        [ -e "$f" ] || continue
        [ "$(basename "$f")" = ".brane" ] && continue
        mv "$f" /home/brane/.brane/
    done
    echo "Migration complete."
fi

# Ensure the brane user owns the home directory
chown -R brane:brane /home/brane

# Copy tmux binary into the volume if missing (the image layer copy is
# hidden when the persistent volume mounts over /home/brane)
if [ ! -f /home/brane/.brane/bin/tmux ] && [ -f /root/.brane/bin/tmux ]; then
    mkdir -p /home/brane/.brane/bin
    cp /root/.brane/bin/tmux /home/brane/.brane/bin/tmux
    chown brane:brane /home/brane/.brane/bin/tmux
fi

# Tailscale state lives inside the brane data volume (single mount on Fly)
TS_STATE=/home/brane/.brane/tailscale
mkdir -p "$TS_STATE"

# Start tailscaled as root (needs privileges for networking)
tailscaled --tun=userspace-networking --statedir="$TS_STATE" &

# Wait for the tailscaled socket
for i in $(seq 1 10); do
    [ -S /var/run/tailscale/tailscaled.sock ] && break
    sleep 1
done

# Authenticate with Tailscale (as root).
# Build hostname: append Fly region if available (e.g., brane-5a04ec-nrt)
TS_HOSTNAME="${TS_HOSTNAME:-brane}"
if [ -n "$FLY_REGION" ]; then
    TS_HOSTNAME="${TS_HOSTNAME}-${FLY_REGION}"
fi
# The node is tag-owned, so its key never expires. Every `up` names the tags:
# one without them asks control to drop them, which needs a login nobody here
# can complete. --timeout makes any such wait fail instead of hang.
TS_TAGS="${TS_TAGS:-tag:brane}"
TS_UP=(tailscale up --reset --hostname="$TS_HOSTNAME" --advertise-tags="$TS_TAGS")

# Fly's OIDC token for this machine (`sub` is <org>:<app>:<machine>), which
# Tailscale's workload identity federation trades for a node key.
fly_oidc_token() {
    local out
    out=$(curl -fsS --unix-socket /.fly/api -X POST http://localhost/v1/tokens/oidc \
        -H 'Content-Type: application/json' --data "{\"aud\":\"$1\"}") || return 1
    case "$out" in
        \{*) printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.token||j.jwt||j.id_token||"")})' ;;
        *) printf '%s' "$out" | tr -d '"\r\n' ;;
    esac
}

# The state on the volume first (every restart after the first boot), then a
# credential: TS_CLIENT_ID (workload identity: no secret on Fly) or TS_AUTHKEY
# (an auth key or OAuth client secret allowed to apply $TS_TAGS).
if "${TS_UP[@]}" --timeout=30s; then
    :
elif [ -n "$TS_CLIENT_ID" ]; then
    ID_TOKEN=$(fly_oidc_token "${TS_AUDIENCE:-api.tailscale.com/${TS_CLIENT_ID}}") || ID_TOKEN=
    if [ -z "$ID_TOKEN" ]; then
        echo "entrypoint: could not get an OIDC token from Fly for Tailscale" >&2
        exit 1
    fi
    "${TS_UP[@]}" --timeout=60s --client-id="${TS_CLIENT_ID}?ephemeral=false&preauthorized=true" --id-token="$ID_TOKEN"
elif [ -n "$TS_AUTHKEY" ]; then
    "${TS_UP[@]}" --timeout=60s --auth-key="$TS_AUTHKEY"
else
    echo "entrypoint: not on the tailnet, and neither TS_CLIENT_ID nor TS_AUTHKEY is set" >&2
    exit 1
fi

# Allow the brane user to manage Tailscale (needed for cert provisioning)
tailscale set --operator=brane || true

# Provision TLS cert from Tailscale (non-fatal if it fails)
gosu brane brane certify 2>/dev/null || true

# Ensure workspace directory exists on the volume
mkdir -p /home/brane/workspace
chown brane:brane /home/brane/workspace

# Ensure .mcp.json exists so agents have brane MCP tools from the start
MCP_JSON=/home/brane/workspace/.mcp.json
if [ ! -f "$MCP_JSON" ]; then
    cat > "$MCP_JSON" <<'MCPEOF'
{"mcpServers":{"brane":{"command":"node","args":["/usr/local/bin/brane","mcp"]}}}
MCPEOF
    chown brane:brane "$MCP_JSON"
fi

# Clear stale daemon meta from the persisted volume — PIDs from a previous
# container life are never valid in a new container, but may collide with
# a live PID here (e.g., tailscaled) and trip the "already running" check.
#
# Not the ports, though. Every melded device's URL and every fold's hook
# config names them, so the daemon comes back on the ones it had, as it
# does after any restart; clearing them moved both on every boot. The main
# port's row still goes (the fold registration below waits for the daemon
# to write it back), so it is read first and handed back with --port. The
# HTTP fallback port's row stays: the daemon only ever takes it as a hint
# for what to bind, and nothing reads it while daemon_tls is unset.
PREV_PORT=$(gosu brane sqlite3 /home/brane/.brane/brane.db \
    "SELECT value FROM meta WHERE key = 'daemon_port';" 2>/dev/null || true)
gosu brane sqlite3 /home/brane/.brane/brane.db \
    "DELETE FROM meta WHERE key IN ('daemon_pid','daemon_token','daemon_port','daemon_version','daemon_tls','daemon_socket');" \
    2>/dev/null || true

# Register the default workspace as a fold (idempotent) once the daemon is up.
# `brane fold` is a daemon client: run before the daemon, it would start one
# of its own, and the exec below would start a second on the same database.
# The daemon records its port only after its socket is bound, and the rows
# above are gone, so a port here means the daemon below is ready.
(
    for i in $(seq 1 120); do
        port=$(gosu brane sqlite3 /home/brane/.brane/brane.db \
            "SELECT value FROM meta WHERE key = 'daemon_port';" 2>/dev/null || true)
        if [ -n "$port" ]; then
            gosu brane brane fold /home/brane/workspace >/dev/null ||
                echo "entrypoint: could not register /home/brane/workspace as a fold" >&2
            exit 0
        fi
        sleep 1
    done
    echo "entrypoint: no daemon after 120s; /home/brane/workspace is not registered as a fold" >&2
) &

# The wake listener holds WAKE_PORT; a daemon port that equals it (from some
# earlier life) could never bind, so let the OS pick instead.
if [ "$PREV_PORT" = "$WAKE_PORT" ]; then PREV_PORT=; fi

# Drop privileges and run the daemon as the brane user.
# --bind 0.0.0.0: tailscaled --tun=userspace-networking doesn't put the
# 100.x.y.z address on a kernel interface, so a specific bind to it fails
# with EADDRNOTAVAIL. Under --bind the daemon applies no IP filter of its
# own, so it answers on every interface in the container. What bounds it is
# the container's reach: Tailscale, Fly's private 6PN (this org's own
# machines), and Fly Proxy, which routes only fly.toml's [http_service]
# internal_port, the wake listener's, and never the daemon's.
# exec: the daemon is the machine's main process. Its own clean exit (sleep:
# manifest, `tailscale down`, exit 0) stops the machine, which restart
# policy "on-failure" leaves stopped; a crash exits non-zero and restarts it.
# --port: the port the last boot had (above). If something else holds it
# now, the daemon exits before writing its row back, so the next boot finds
# none and lets the OS pick.
exec gosu brane brane daemon start --foreground --bind 0.0.0.0 ${PREV_PORT:+--port "$PREV_PORT"} "$@"
