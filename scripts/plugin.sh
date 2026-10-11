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

quote_arg() {
  printf '%s' "'"
  while :; do
    case $1 in
      *"'"*)
        printf '%s' "${1%%"'"*}" "'\\''"
        set -- "${1#*"'"}"
        ;;
      *)
        printf '%s' "$1" "'"
        break
        ;;
    esac
  done
}

repair_command() {
  printf '%s' 'sh '
  quote_arg "$ROOT/scripts/plugin.sh"
  printf '%s' ' install '
  quote_arg "$AGENT_DIR"
  printf '\n'
}

sidebar_help() {
  printf '%s\n' \
    'Sidebar next: edit [ui.sidebar.agents] rows in the config.toml read by the Herdr client that draws your sidebar.' \
    '  Usually ~/.config/herdr/config.toml; if that client uses HERDR_CONFIG_PATH, edit that file instead.' \
    '  For a remote client, edit the client layout, not just the Herdr host config. This script edits no config.' \
    '  Herdr allows at most 16 configured rows, counting rows with empty tokens; keep your existing rows and styles.' \
    '  Put "$main_model" beside "agent" in its existing row, e.g. ["agent", "$main_model"]; if no agent row exists, add one row for both tokens.' \
    '  Reuse existing child rows and add only missing slots in order from "$subagents_1".' \
    '  With enough room and no plugin config.json, maxRows defaults to four: ["$subagents_1"], ["$subagents_2"], ["$subagents_3"], ["$subagents_4"].' \
    '  An existing config.json maxRows (0..13), including 8, stays the target; do not silently reset it to four.' \
    '  Count R existing rows (including child rows); a new main row costs A=1, otherwise A=0. At most 16-R-A missing child rows fit.' \
    '  Example: with an existing agent row, no child rows and R=13, only three of four default slots fit; set maxRows=3 manually or free one row.' \
    '  If that budget is negative, rework rows for the main row; if too small for the target, free/rework rows or manually set maxRows to visible contiguous slots (including 0).' \
    '  This script never changes user config or rows. Reload that client instance with: herdr server reload-config' \
    '  Start OMP from a Herdr pane (or restart an existing OMP session after its task finishes).' \
    '  In OMP, run /herdr-subagents to inspect pane binding, bridge state and desired tokens;' \
    '  then confirm the main model actually appears in the sidebar.' \
    '  For extra slots and styling, see README.md (Advanced setup, Styling, Row limit).'
}

case "$COMMAND" in
  install)
    test -f "$SOURCE" || { printf 'Missing bridge: %s\n' "$SOURCE" >&2; exit 1; }
    mkdir -p "$AGENT_DIR/extensions"
    if test -L "$TARGET" && test "$(readlink "$TARGET")" = "$SOURCE"; then
      printf 'Already linked: %s -> %s\n' "$TARGET" "$SOURCE"
    elif test -L "$TARGET" && ! test -e "$TARGET"; then
      # A plugin update or a moved checkout leaves the old link dangling.
      printf 'Replacing broken link: %s -> %s\n' "$TARGET" "$(readlink "$TARGET")"
      ln -sf "$SOURCE" "$TARGET"
      printf 'Installed: %s -> %s\n' "$TARGET" "$SOURCE"
    elif test -e "$TARGET" || test -L "$TARGET"; then
      if test -L "$TARGET"; then
        printf 'Refusing to replace a live link to another source: %s -> %s\n' "$TARGET" "$(readlink "$TARGET")" >&2
        printf 'Use the installed package script for that source, or choose another agent directory; no link was changed.\n' >&2
      else
        printf 'Refusing to replace an existing file: %s\n' "$TARGET" >&2
        printf 'Move the file yourself or choose another agent directory; no file was changed.\n' >&2
      fi
      exit 1
    else
      ln -s "$SOURCE" "$TARGET"
      printf 'Installed: %s -> %s\n' "$TARGET" "$SOURCE"
    fi
    printf 'Profile: %s\nAgent directory: %s\nPackage: %s\nSource: %s\n' "$PROFILE" "$AGENT_DIR" "$ROOT" "$SOURCE"
    printf '%s\n' \
      'Link only: OMP load, metadata publication and sidebar display have not been checked.' \
      'Verified on OMP 18.1.20 and 18.4.1; requires the AgentRegistry SDK export.' \
      'Keep omp-subagents enabled in Herdr; marketplace installations are already registered.' \
      'Next: configure the sidebar below, then start a new OMP session from a Herdr pane.' \
      'For an existing session, finish its current task, quit OMP and use omp --resume <session-id> to load the bridge/update.' \
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
    printf 'Profile: %s\nAgent directory: %s\nPackage: %s\nSource: %s\nOMP extension: %s\n' "$PROFILE" "$AGENT_DIR" "$ROOT" "$SOURCE" "$TARGET"
    printf '%s\n' \
      'Checking only: Herdr CLI version/metadata flags, bridge link, plugin enabled state and config path/type.' \
      'Not checked: live OMP API or extension load, config.json contents/effective maxRows, applied client layout/reload, metadata publication or sidebar UI.' \
      'No provider requests or metadata writes are made.'
    "$HERDR" --version || { printf 'Next: check the Herdr CLI at %s (HERDR_BIN_PATH).\n' "$HERDR" >&2; exit 1; }
    HELP=$("$HERDR" pane report-metadata --help) || {
      printf 'Next: check that %s supports pane report-metadata --help.\n' "$HERDR" >&2
      exit 1
    }
    for FLAG in --source --token --clear-token --ttl-ms; do
      case "$HELP" in *"$FLAG"*) ;; *)
        printf 'Missing required Herdr metadata flag: %s; next: use a Herdr CLI with this flag.\n' "$FLAG" >&2; exit 1 ;; esac
    done
    if test -L "$TARGET" && ! test -e "$TARGET"; then
      printf 'Broken bridge link: %s -> %s\n' "$TARGET" "$(readlink "$TARGET")" >&2
      printf '%s\n' 'Next: run this repair command:' >&2
      repair_command >&2
      exit 1
    elif test -L "$TARGET" && test "$(readlink "$TARGET")" = "$SOURCE"; then
      printf 'Bridge link: OK (%s -> %s)\n' "$TARGET" "$SOURCE"
    elif test -L "$TARGET"; then
      printf 'Bridge link points to another live source: %s -> %s\n' "$TARGET" "$(readlink "$TARGET")" >&2
      printf '%s\n' 'This is not evidence that the installed bridge is broken. Run doctor from the installed package for that link, or choose a different agent directory; no link was changed.' >&2
      exit 1
    elif test -e "$TARGET"; then
      printf 'Bridge path is a regular file or directory, not this package link: %s\n' "$TARGET" >&2
      printf '%s\n' 'Next: inspect/move it yourself or choose another agent directory; install will not overwrite it.' >&2
      exit 1
    else
      printf 'Bridge link missing: %s\n' "$TARGET" >&2
      printf '%s\n' 'Next: run this repair command:' >&2
      repair_command >&2
      exit 1
    fi
    # The bridge publishes only while Herdr lists this plugin as enabled.
    if "$HERDR" plugin list --json | tr '{' '\n' | grep '"plugin_id":"omp-subagents"' | grep -q '"enabled":true'; then
      printf '%s\n' 'Herdr plugin: enabled'
    else
      printf '%s\n' 'Herdr plugin omp-subagents is not installed or not enabled; next: install/link or enable it in Herdr.' >&2
      exit 1
    fi
    # The bridge asks Herdr for the same directory; only the path is reported here.
    CONFIG_DIR=$("$HERDR" plugin config-dir omp-subagents) || {
      printf '%s\n' 'Cannot resolve the plugin config directory; next: check herdr plugin config-dir omp-subagents.' >&2
      exit 1
    }
    case "$CONFIG_DIR" in
      *'
'*|''|[!/]*)
        printf 'Herdr returned an invalid plugin config directory: %s; next: check the Herdr CLI/config-dir output.\n' "$CONFIG_DIR" >&2
        exit 1 ;;
    esac
    CONFIG_FILE="$CONFIG_DIR/config.json"
    if test -f "$CONFIG_FILE"; then
      printf 'Plugin settings: %s\n' "$CONFIG_FILE"
      printf '%s\n' 'OMP validates maxRows on every 5 s read; /herdr-subagents shows the effective value and any error.'
    elif test -e "$CONFIG_FILE"; then
      printf 'Plugin settings path is not a regular file: %s; next: inspect/move that path yourself.\n' "$CONFIG_FILE" >&2
      exit 1
    else
      printf 'Plugin settings: %s (absent; maxRows defaults to 4)\n' "$CONFIG_FILE"
    fi
    printf 'Pane: %s\nSocket: %s\n' "${HERDR_PANE_ID:-not inside Herdr}" "${HERDR_SOCKET_PATH:-unset}"
    printf '%s\n' \
      'Doctor exit 0: only the listed prerequisites passed; sidebar display is not confirmed.' \
      'Next: in an OMP session started from a Herdr pane, run /herdr-subagents, then confirm the main model appears in the sidebar.'
    sidebar_help
    ;;
  *)
    printf 'Usage: sh scripts/plugin.sh {install|uninstall|doctor} [OMP_AGENT_DIR]\n' >&2
    exit 2
    ;;
esac
