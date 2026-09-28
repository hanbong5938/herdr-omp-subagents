#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
SOURCE="$ROOT/extension.ts"
COMMAND=${1:-doctor}
CONFIG_ROOT=${PI_CONFIG_DIR:-.omp}
case "$CONFIG_ROOT" in /*) ;; *) CONFIG_ROOT="$HOME/$CONFIG_ROOT" ;; esac
PROFILE=${OMP_PROFILE-${PI_PROFILE:-default}}
case "$PROFILE" in ''|default) AGENT_DIR=${PI_CODING_AGENT_DIR:-"$CONFIG_ROOT/agent"} ;;
  *[!a-zA-Z0-9_-]*) printf '%s\n' 'Invalid OMP profile; pass the agent directory explicitly.' >&2; exit 1 ;;
  *) AGENT_DIR="$CONFIG_ROOT/profiles/$PROFILE/agent" ;;
esac
AGENT_DIR=${2:-$AGENT_DIR}
TARGET="$AGENT_DIR/extensions/herdr-omp-subagents.ts"
HERDR=${HERDR_BIN_PATH:-herdr}

sidebar_help() {
  printf '%s\n' \
    'Required sidebar setup: add one row per slot to [ui.sidebar.agents] rows' \
    '  in ~/.config/herdr/config.toml, before ["$cache"], keeping existing rows:' \
    '  ["$subagents_1"], ["$subagents_2"], ["$subagents_3"], ["$subagents_4"],' \
    'One agent per row; the fourth row becomes +N when more are active.' \
    'Unused rows disappear. Optional style: [{ token = "$subagents_1", fg = "#56b6c2" }]' \
    'Then run: herdr server reload-config' \
    'Use /herdr-subagents inside OMP for live identities and activation status.'
}

case "$COMMAND" in
  install)
    test -f "$SOURCE" || { printf 'Missing bridge: %s\n' "$SOURCE" >&2; exit 1; }
    mkdir -p "$AGENT_DIR/extensions"
    if test -L "$TARGET" && test "$(readlink "$TARGET")" = "$SOURCE"; then
      printf 'Already installed: %s\n' "$TARGET"
    elif test -L "$TARGET" && ! test -e "$TARGET"; then
      # A plugin update or a moved checkout leaves the old link dangling.
      printf 'Replacing broken link: %s -> %s\n' "$TARGET" "$(readlink "$TARGET")"
      ln -sf "$SOURCE" "$TARGET"
      printf 'Installed: %s -> %s\n' "$TARGET" "$SOURCE"
    elif test -e "$TARGET" || test -L "$TARGET"; then
      printf 'Refusing to replace an existing file: %s\n' "$TARGET" >&2
      exit 1
    else
      ln -s "$SOURCE" "$TARGET"
      printf 'Installed: %s -> %s\n' "$TARGET" "$SOURCE"
    fi
    printf '%s\n' \
      'Verified on OMP 18.1.20 and 18.4.1; requires the AgentRegistry SDK export.' \
      'Keep omp-subagents enabled in Herdr; marketplace installations are already registered.'
    printf '%s\n' 'Restart each already-running OMP session to load this new extension.' \
      'After the current task finishes, quit OMP, then use omp --resume <session-id>.' \
      'Linking or /reload-plugins does not load newly installed extension modules.'
    sidebar_help
    ;;
  uninstall)
    if test -L "$TARGET" && { test "$(readlink "$TARGET")" = "$SOURCE" || ! test -e "$TARGET"; }; then
      rm "$TARGET"
      printf 'Removed bridge link: %s\n' "$TARGET"
    elif test -e "$TARGET" || test -L "$TARGET"; then
      printf 'Refusing to remove a file not owned by this package: %s\n' "$TARGET" >&2
      exit 1
    fi
    printf '%s\n' 'Disable/unlink omp-subagents in Herdr; active bridges clear on the next activation check.'
    printf '%s\n' 'Restart OMP to unload the extension. Existing sidebar rows are not modified.'
    ;;
  doctor)
    printf 'Package: %s\nOMP extension: %s\n' "$ROOT" "$TARGET"
    "$HERDR" --version
    HELP=$("$HERDR" pane report-metadata --help)
    for FLAG in --source --token --clear-token --ttl-ms; do
      case "$HELP" in *"$FLAG"*) ;; *)
        printf 'Missing required Herdr metadata flag: %s\n' "$FLAG" >&2; exit 1 ;; esac
    done
    if test -L "$TARGET" && ! test -e "$TARGET"; then
      printf 'Bridge link is broken: %s -> %s; run install to repair it.\n' "$TARGET" "$(readlink "$TARGET")" >&2
      exit 1
    elif test -L "$TARGET" && test "$(readlink "$TARGET")" = "$SOURCE"; then
      printf '%s\n' 'Bridge link: OK'
    else
      printf '%s\n' 'Bridge not registered here; run install or pass your profile agent directory.' >&2
      exit 1
    fi
    # The bridge publishes only while Herdr lists this plugin as enabled.
    if "$HERDR" plugin list --json | tr '{' '\n' | grep '"plugin_id":"omp-subagents"' | grep -q '"enabled":true'; then
      printf '%s\n' 'Herdr plugin: enabled'
    else
      printf '%s\n' 'Herdr plugin omp-subagents is not installed or not enabled; install, link or enable it.' >&2
      exit 1
    fi
    printf 'Pane: %s\nSocket: %s\n' "${HERDR_PANE_ID:-not inside Herdr}" "${HERDR_SOCKET_PATH:-unset}"
    printf '%s\n' 'No provider requests made. Use /herdr-subagents to verify the live OMP API.'
    sidebar_help
    ;;
  *)
    printf 'Usage: sh scripts/plugin.sh {install|uninstall|doctor} [OMP_AGENT_DIR]\n' >&2
    exit 2
    ;;
esac
