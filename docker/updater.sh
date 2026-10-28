#!/bin/sh
# EnsoCode updater sidecar：轮询共享卷里宿主写的请求（见 src/server/update/dockerControl.ts）。
# pull：拉 $ENSO_IMAGE 并回报版本；apply：用 compose 重建 relay + server。
set -u
C=/control
SELF=$(hostname)

label() { docker inspect -f "{{ index .Config.Labels \"$1\" }}" "$SELF" 2>/dev/null; }
PROJECT=$(label com.docker.compose.project)
WORKDIR=$(label com.docker.compose.project.working_dir)
set --
for file in $(label com.docker.compose.project.config_files | tr ',' ' '); do
  set -- "$@" -f "/compose/$(basename "$file")"
done
[ -f /compose/.env ] && set -- "$@" --env-file /compose/.env
[ $# -gt 0 ] || set -- -f /compose/compose.yaml

state() {
  printf 'id=%s\nphase=%s\nchanged=%s\nversion=%s\nerror=%s\n' \
    "$1" "$2" "${3:-0}" "${4:-}" "$(printf '%s' "${5:-}" | tr '\n' ' ' | cut -c1-300)" >"$C/state.tmp"
  mv "$C/state.tmp" "$C/state"
}
image_id() { docker image inspect -f '{{.Id}}' "$ENSO_IMAGE" 2>/dev/null; }
image_version() {
  docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$ENSO_IMAGE" 2>/dev/null
}

echo "enso-updater: project=$PROJECT image=$ENSO_IMAGE"
while :; do
  touch "$C/alive"
  if [ -f "$C/request" ]; then
    read -r id action <"$C/request"
    rm -f "$C/request"
    state "$id" running
    case "$action" in
      pull)
        before=$(image_id)
        if out=$(docker pull -q "$ENSO_IMAGE" 2>&1); then
          changed=0
          [ "$before" != "$(image_id)" ] && changed=1
          state "$id" "done" "$changed" "$(image_version)"
        else
          state "$id" failed 0 "" "$out"
        fi
        ;;
      apply)
        if out=$(docker compose -p "$PROJECT" --project-directory "$WORKDIR" "$@" up -d --no-build relay server 2>&1); then
          state "$id" "done"
        else
          state "$id" failed 0 "" "$out"
        fi
        ;;
      *) state "$id" failed 0 "" "unknown action $action" ;;
    esac
    echo "enso-updater: $action -> $(grep '^phase=' "$C/state")"
  fi
  sleep 2
done
