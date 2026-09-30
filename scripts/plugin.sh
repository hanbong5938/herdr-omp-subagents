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
    'Sidebar setup (this script edits no config): in ~/.config/herdr/config.toml,' \
    '  [ui.sidebar.agents] rows, keep your existing rows and add:' \
    '  "$main_model" to the row that has "agent", e.g. ["agent", "$main_model"]' \
    '  one row per child slot, in order, before ["$cache"] if present:' \
    '  ["$subagents_1"], ["$subagents_2"], ["$subagents_3"], ["$subagents_4"],' \
    '  ["$subagents_5"], ["$subagents_6"], ["$subagents_7"], ["$subagents_8"],' \
    '  ["$subagents_9"], ["$subagents_10"], ["$subagents_11"], ["$subagents_12"],' \
    '  ["$subagents_13"],' \
    'Herdr draws at most 16 rows: state, agent and cache rows leave 13 child slots;' \
    '  each other custom row costs one. Unused rows disappear.' \
    'Optional style: [{ token = "$subagents_1", fg = "#56b6c2" }]' \
    'Then run: herdr server reload-config' \
    'Child rows: maxRows in config.json in the directory printed by' \
    '  herdr plugin config-dir omp-subagents, e.g. {"maxRows": 8}' \
    '  Integer 0..13; missing file means 4; the last allowed row becomes +N.' \
    '  Invalid values keep the last valid one; OMP re-reads the file every 5 s.' \
    '  Keep maxRows at or below the number of $subagents_N rows you list.' \
    'Use /herdr-subagents inside OMP for live identities, max rows and activation status.'
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
    printf '%s\n' 'Newly installed: running OMP sessions have not loaded it; restart each to load it.' \
      'Already installed: running OMP sessions keep the bridge code they loaded; restart each to load updates.' \
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
    # The bridge asks Herdr for the same directory; only the path is reported here.
    CONFIG_DIR=$("$HERDR" plugin config-dir omp-subagents) || {
      printf '%s\n' 'Cannot resolve the plugin config directory: herdr plugin config-dir omp-subagents failed.' >&2
      exit 1
    }
    case "$CONFIG_DIR" in
      *'
'*|''|[!/]*)
        printf 'Herdr returned an invalid plugin config directory: %s\n' "$CONFIG_DIR" >&2
        exit 1 ;;
    esac
    CONFIG_FILE="$CONFIG_DIR/config.json"
    if test -f "$CONFIG_FILE"; then
      printf 'Plugin settings: %s\n' "$CONFIG_FILE"
      printf '%s\n' 'OMP validates maxRows on every 5 s read; /herdr-subagents shows the effective value and any error.'
    elif test -e "$CONFIG_FILE"; then
      printf 'Plugin settings path is not a regular file: %s\n' "$CONFIG_FILE" >&2
      exit 1
    else
      printf 'Plugin settings: %s (absent; maxRows defaults to 4)\n' "$CONFIG_FILE"
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
