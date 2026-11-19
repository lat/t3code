#!/usr/bin/env bash
# Update this fork: merge official T3 Code, test, build, back up, install, push.
# Automates FORK.md. Run `scripts/update-fork.sh --help` for options.

# Everything sits in one { } block so bash reads the whole file before running any of it.
# Otherwise a git switch or merge that rewrites this file mid-run could break the run.
{
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="ui/home-dashboard"
UPSTREAM="upstream/main"
APP_NAME="T3 Code (Beta)"
APP_PATH="/Applications/$APP_NAME.app"
NIGHTLY_NAME="T3 Code (Nightly)"
USERDATA="$HOME/.t3/userdata"
DEV_HOME="$REPO/.t3"
BACKUPS="$HOME/.t3-backups"
KEEP_BACKUPS=2   # after a successful install, older backups beyond this many are deleted
# A browser test that also fails on unmodified upstream. If it's the only failure, the checks count as passed.
KNOWN_FAILURE="a shortcut conditioned on rightPanelOpen"
SERVICE_LABEL="com.t3tools.t3code.service"
SERVICE_PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
SELF="$REPO/scripts/update-fork.sh"

export PATH="$HOME/.local/share/vite-plus/bin:$PATH"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# ---------- helpers ----------

if [ -t 1 ]; then
  B=$'\e[1m' DIM=$'\e[2m' RED=$'\e[31m' GRN=$'\e[32m' YLW=$'\e[33m' CYN=$'\e[36m' R=$'\e[0m'
else
  B="" DIM="" RED="" GRN="" YLW="" CYN="" R=""
fi

step() { printf '\n%s==> %s%s\n' "$B$CYN" "$*" "$R"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓ %s%s\n' "$GRN" "$*" "$R"; }
warn() { printf '    %s! %s%s\n' "$YLW" "$*" "$R"; }
die()  { printf '\n%s✗ %s%s\n' "$RED$B" "$*" "$R" >&2; exit 1; }

# ask "Question" y|n  -> returns 0 for yes. Uses the default when there is no terminal.
ask() {
  local prompt="$1" def="$2" hint reply
  [ "$def" = y ] && hint="[Y/n]" || hint="[y/N]"
  if [ "$ASSUME_YES" = 1 ]; then reply="$def"
  elif [ -r /dev/tty ]; then read -r -p "    $prompt $hint " reply </dev/tty || reply=""
  else reply=""
  fi
  reply="$(printf '%s' "${reply:-$def}" | tr '[:upper:]' '[:lower:]')"
  [ "$reply" = y ] || [ "$reply" = yes ]
}

# Captures ps first so the matcher's own command line can't match itself.
app_running() {
  local procs
  procs="$(ps -axo command=)"
  grep -qF "/$1.app/Contents/MacOS/" <<<"$procs"
}
service_loaded() { launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; }

# True when the check:changed log in $1 failed only because of $KNOWN_FAILURE:
# one failed step, one failed test, no timeouts or unhandled errors, and that test is the known one.
only_known_failure() {
  local text summary failed_steps failed_tests
  text="$(sed $'s/\x1b\\[[0-9;?]*[A-Za-z]//g' "$1")"
  summary="$(sed -n '/check:changed summary/,$p' <<<"$text")"
  [ -n "$summary" ] || return 1
  grep -q 'TIMEOUT' <<<"$summary" && return 1
  failed_steps="$(grep -cE '^ +FAIL ' <<<"$summary" || true)"
  [ "$failed_steps" = 1 ] || return 1
  failed_tests="$(grep -oE 'Tests +[0-9]+ failed' <<<"$text" | grep -oE '[0-9]+' | awk '{s += $1} END {print s + 0}')"
  [ "$failed_tests" = 1 ] || return 1
  grep -qE '^ *Errors +[0-9]+ error' <<<"$text" && return 1
  grep -qF "$KNOWN_FAILURE" <<<"$text"
}

# Delete the oldest backups so only the newest $KEEP_BACKUPS remain. Names are dates, so they sort in order.
prune_backups() {
  local all count d size
  all="$(ls -1d "$BACKUPS"/20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]* 2>/dev/null | sort || true)"
  count="$(grep -c . <<<"$all" || true)"
  [ "$count" -gt "$KEEP_BACKUPS" ] || return 0
  head -n "$((count - KEEP_BACKUPS))" <<<"$all" | while read -r d; do
    size="$(du -sh "$d" | awk '{print $1}')"
    rm -rf "$d"
    ok "Deleted the oldest backup, $(basename "$d") ($size)"
  done
}

# PIDs of processes holding the T3 database or its ownership lock (server-owner.sqlite).
db_holders() {
  lsof -t "$USERDATA/server-owner.sqlite" "$USERDATA/statev2.sqlite" 2>/dev/null | sort -u || true
}

# True when this script runs inside T3 itself (its terminal or an agent), where quitting T3 would kill us.
inside_t3() {
  local pid=$$ cmd
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *"T3 Code ("*".app/"*|*"/.t3/runtime/versions/"*) return 0 ;;
    esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  return 1
}

usage() {
  cat <<EOF
${B}update-fork.sh${R} — update your T3 Code fork ($BRANCH)

  ${B}scripts/update-fork.sh${R}            merge upstream, check, build, then install and push
  ${B}scripts/update-fork.sh install${R}    only back up, install the newest built DMG, and push

Options:
  --skip-checks   don't run 'vp run check:changed'
  --dev           try the build in a dev window (against a copy of your data) before building
  --skip-dev      don't ask about the dev window
  --build-only    stop after building the DMG
  --rebuild       build even when there's nothing new upstream
  --no-push       don't push to your GitHub fork
  -y, --yes       accept the default answer to every question
  -h, --help      show this help

Run it from Terminal or Ghostty rather than inside T3: the install step has to quit T3.
If you run it inside T3, it stops after the build and tells you what to run next.
EOF
}

# ---------- args ----------

MODE=all SKIP_CHECKS=0 DEV=ask BUILD_ONLY=0 REBUILD=0 PUSH=1 ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    install) MODE=install ;;
    --skip-checks) SKIP_CHECKS=1 ;;
    --dev) DEV=yes ;;
    --skip-dev) DEV=no ;;
    --build-only) BUILD_ONLY=1 ;;
    --rebuild) REBUILD=1 ;;
    --no-push) PUSH=0 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "Unknown option: $arg" ;;
  esac
done

cd "$REPO"
for cmd in git gh vp hdiutil ditto; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' isn't installed or isn't on PATH."
done

# ---------- phase 1: merge, check, build ----------

merge_and_build() {
  step "Checking the repository"

  # Pick up where a conflicted merge left off.
  if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
      warn "A merge is still in progress with unresolved conflicts:"
      git diff --name-only --diff-filter=U | sed 's/^/      /'
      die "Resolve them (or run 'git merge --abort'), then run this script again."
    fi
    info "Finishing the merge you resolved…"
    git commit --no-edit -q
    ok "Merge committed"
  fi

  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git status --short --untracked-files=no | sed 's/^/      /'
    die "You have uncommitted changes. Commit or stash them first."
  fi

  local current
  current="$(git branch --show-current)"
  if [ "$current" != "$BRANCH" ]; then
    info "Switching from '$current' to '$BRANCH'"
    git switch -q "$BRANCH"
  fi
  ok "On $BRANCH, working tree clean"

  step "Fetching official changes"
  git fetch -q upstream
  local behind
  behind="$(git rev-list --count "HEAD..$UPSTREAM")"
  if [ "$behind" = 0 ]; then
    ok "Already up to date with $UPSTREAM"
    if [ "$REBUILD" = 0 ] && ! ask "Nothing new upstream. Build and install anyway?" n; then
      push_fork
      exit 0
    fi
  else
    info "$behind new commits upstream. Latest:"
    git log --format="      ${DIM}%h${R} %s" -n 12 "HEAD..$UPSTREAM"
    [ "$behind" -gt 12 ] && info "${DIM}…and $((behind - 12)) more${R}"

    step "Merging $UPSTREAM into $BRANCH"
    PRE_MERGE="$(git rev-parse HEAD)"
    if ! git merge --no-edit -q "$UPSTREAM"; then
      warn "The merge has conflicts in:"
      git diff --name-only --diff-filter=U | sed 's/^/      /'
      cat <<EOF

    Keep the official changes and re-apply the dashboard lines
    (search for ${B}showHomeDashboard${R} and ${B}data-home-hero${R}).
    Then ${B}git add${R} the files and run this script again; it finishes the merge.
    Or give up for now with: ${B}git merge --abort${R}
EOF
      exit 1
    fi
    ok "Merged (undo with: git reset --hard ${PRE_MERGE:0:10})"
  fi

  step "Installing dependencies"
  vp i
  ok "Dependencies installed"

  if [ "$SKIP_CHECKS" = 0 ]; then
    step "Running checks (vp run check:changed)"
    local log
    log="$(mktemp)"
    if FORCE_COLOR=1 vp run check:changed 2>&1 | tee "$log"; then
      ok "Checks passed"
    elif only_known_failure "$log"; then
      ok "Checks passed, apart from the ChatView 'rightPanelOpen' test that also fails upstream"
    else
      warn "Checks failed."
      if ! ask "Continue anyway?" n; then
        [ -n "${PRE_MERGE:-}" ] && info "To undo the merge: git reset --hard ${PRE_MERGE:0:10}"
        rm -f "$log"
        exit 1
      fi
    fi
    rm -f "$log"
  fi

  if [ "$DEV" = yes ] || { [ "$DEV" = ask ] && ask "Try it in a dev window first (uses a copy of your data)?" n; }; then
    step "Starting a dev build against $DEV_HOME"
    vp run migrate-dev-db --base-dir "$DEV_HOME"
    info "Open a new thread and check the dashboard. Press ${B}Ctrl-C${R} when done to continue."
    trap ':' INT
    vp run dev --home-dir "$DEV_HOME" || true
    trap - INT
    echo
    ask "Did everything look right? Continue to build?" y || exit 1
  fi

  step "Building the app (this takes a few minutes)"
  local marker
  marker="$(mktemp)"
  vp run dist:desktop:dmg:arm64
  DMG="$(find "$REPO/release" -maxdepth 1 -name 'T3-Code-*-arm64.dmg' -newer "$marker" -print 2>/dev/null | head -n1 || true)"
  rm -f "$marker"
  [ -n "$DMG" ] || die "The build finished but no new DMG appeared in release/."
  ok "Built $(basename "$DMG")"
}

# ---------- phase 2: back up, install, push ----------

find_latest_dmg() {
  DMG="$(ls -t "$REPO"/release/T3-Code-*-arm64.dmg /Applications/T3-Code-*-arm64.dmg 2>/dev/null | head -n1 || true)"
  [ -n "$DMG" ] || die "No built DMG in release/ or /Applications. Run the full update first."
}

push_fork() {
  [ "$PUSH" = 1 ] || return 0
  if [ -z "$(git rev-list "origin/$BRANCH..$BRANCH" 2>/dev/null)" ]; then
    return 0
  fi
  step "Pushing $BRANCH to your GitHub fork"
  local out
  if out="$(git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin "$BRANCH" 2>&1)"; then
    ok "Pushed"
  else
    printf '%s\n' "$out" | sed 's/^/      /'
    if grep -q 'workflow' <<<"$out"; then
      warn "Your gh login needs the 'workflow' scope. Run this once, then: $SELF install"
      info "gh auth refresh -h github.com -s workflow"
    fi
    warn "Push failed. Your app is installed; push later with: $SELF install"
  fi
}

install_app() {
  step "Getting ready to install $(basename "$DMG")"

  if app_running "$NIGHTLY_NAME"; then
    die "$NIGHTLY_NAME is running. Quit it first; it must never run alongside the Beta."
  fi

  if inside_t3 && { app_running "$APP_NAME" || service_loaded; }; then
    echo "$SELF install" | pbcopy 2>/dev/null || true
    cat <<EOF

    ${B}The build is ready.${R} This script is running inside T3, so it can't quit T3 for you.
    Quit T3 Code (Beta), then in Terminal or Ghostty run (it's on your clipboard):

        ${B}$SELF install${R}

EOF
    exit 0
  fi

  if app_running "$APP_NAME"; then
    ask "Quit $APP_NAME now to install the update?" y || die "Stopped. Run '$SELF install' when ready."
    osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
    local i=0
    while app_running "$APP_NAME"; do
      i=$((i + 1))
      [ "$i" -le 60 ] || die "$APP_NAME didn't quit within a minute. Quit it yourself and run '$SELF install'."
      sleep 1
    done
    ok "$APP_NAME quit"
  fi

  # The background service starts its own server on ~/.t3/userdata as soon as the app quits.
  # Stop it so nothing writes to the database while we copy it and swap the app.
  SERVICE_WAS_LOADED=0
  if service_loaded; then
    SERVICE_WAS_LOADED=1
    info "Pausing the T3 background service…"
    launchctl bootout --wait "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null \
      || launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true
    sleep 1
    service_loaded && die "Couldn't stop the background service ($SERVICE_LABEL)."
    ok "Background service paused"
  fi
  restore_service_on_exit() {
    if [ "${SERVICE_WAS_LOADED:-0}" = 1 ] && ! service_loaded && [ -f "$SERVICE_PLIST" ]; then
      launchctl bootstrap "gui/$(id -u)" "$SERVICE_PLIST" 2>/dev/null || true
    fi
  }
  trap restore_service_on_exit EXIT

  step "Backing up your data"
  [ -d "$USERDATA" ] || die "$USERDATA doesn't exist."
  local holders tries=0
  while holders="$(db_holders)"; [ -n "$holders" ]; do
    tries=$((tries + 1))
    if [ "$tries" -gt 30 ]; then
      warn "These processes still have your T3 database open:"
      printf '%s\n' "$holders" | while read -r p; do info "  $(ps -o pid=,command= -p "$p" | cut -c1-120)"; done
      die "Quit them, then run: $SELF install"
    fi
    sleep 1
  done
  ok "Nothing has your database open"
  local need avail backup
  need="$(du -sk "$USERDATA" | cut -f1)"
  avail="$(df -k "$HOME" | awk 'NR==2 {print $4}')"
  [ "$avail" -gt $((need + 5 * 1024 * 1024)) ] \
    || die "Not enough free disk space for a backup ($((need / 1024 / 1024)) GB needed, plus 5 GB to spare)."
  mkdir -p "$BACKUPS"
  backup="$BACKUPS/$(date +%F)"
  [ -e "$backup" ] && backup="$BACKUPS/$(date +%F-%H%M%S)"
  info "Copying $((need / 1024 / 1024)) GB to $backup …"
  cp -R "$USERDATA" "$backup"
  ok "Backed up to $backup"

  step "Installing $APP_NAME"
  local mnt app
  mnt="$(mktemp -d)"
  hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mnt" "$DMG"
  app="$mnt/$APP_NAME.app"
  if [ ! -d "$app" ]; then
    hdiutil detach -quiet "$mnt" || true
    die "The DMG doesn't contain '$APP_NAME.app'."
  fi
  rm -rf "/Applications/.$APP_NAME.new.app"
  ditto "$app" "/Applications/.$APP_NAME.new.app"
  hdiutil detach -quiet "$mnt" || hdiutil detach -quiet -force "$mnt" || true
  rmdir "$mnt" 2>/dev/null || true
  rm -rf "$APP_PATH"
  mv "/Applications/.$APP_NAME.new.app" "$APP_PATH"
  ok "Installed $(defaults read "$APP_PATH/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo 'new build')"

  push_fork

  step "Opening $APP_NAME"
  open "$APP_PATH"
  # Wait until the new app's server holds the ownership lock, so the service can't claim the data first.
  local i=0
  until [ -n "$(lsof -t "$USERDATA/server-owner.sqlite" 2>/dev/null || true)" ] || [ "$i" -ge 90 ]; do
    i=$((i + 1)); sleep 1
  done
  trap - EXIT
  if [ "$SERVICE_WAS_LOADED" = 1 ]; then
    if [ "$i" -ge 90 ]; then
      warn "$APP_NAME didn't finish starting within 90 seconds, so the background service stays off."
      info "Once T3 is open, turn it back on with: ~/.t3/bin/t3 service install"
    # Re-install the service from the new app so it runs the new version, not the old pinned one.
    elif "$HOME/.t3/bin/t3" service install >/dev/null 2>&1; then
      ok "Background service updated to the new version"
    else
      restore_service_on_exit
      warn "Couldn't update the background service, so it's back on its old version."
      info "Fix it later with: ~/.t3/bin/t3 service install"
    fi
  fi

  prune_backups
  printf '\n%s✓ Done.%s Your data from before this update is in %s.\n' "$GRN$B" "$R" "$backup"
  info "Only the $KEEP_BACKUPS newest backups are kept; older ones are deleted after each update."
  info "If the new build is broken, see 'If something goes wrong' in FORK.md."
}

# ---------- main ----------

DMG="" PRE_MERGE=""
if [ "$MODE" = install ]; then
  [ "$(git branch --show-current)" = "$BRANCH" ] || die "Switch to $BRANCH first."
  find_latest_dmg
  install_app
  exit 0
fi

merge_and_build
if [ "$BUILD_ONLY" = 1 ]; then
  printf '\n%s✓ Built %s.%s Install it with: %s install\n' "$GRN$B" "$(basename "$DMG")" "$R" "$SELF"
  exit 0
fi
install_app
exit 0
}
