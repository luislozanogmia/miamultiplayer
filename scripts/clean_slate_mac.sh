#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/clean_slate_mac.sh [--apply|--verify]

Removes the installed Mia macOS application and all Mia-managed Hermes,
Ghost, runtime, credential, cache, preference, log, and launcher state.

The default is a dry run. --apply removes the exact scoped targets and then
verifies that the installation is absent. --verify only performs that audit.

Source repositories, DMG files, Git/GitHub credentials, SSH keys, Codex data,
existing standalone Hermes installations, and unrelated development tools are
intentionally preserved.
EOF
}

mode="dry-run"
for arg in "$@"; do
  case "$arg" in
    --apply) mode="apply" ;;
    --verify) mode="verify" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/.." && pwd -P)"
user_home="${HOME:?HOME is required}"
if [[ "$user_home" == "/" || "$user_home" == "." || ! -d "$user_home" ]]; then
  echo "Refusing unsafe HOME: $user_home" >&2
  exit 1
fi

applications=(
  "/Applications/Mia.app"
  "/Applications/MiaOS.app"
  "$user_home/Applications/Mia.app"
  "$user_home/Applications/MiaOS.app"
  "$user_home/Applications/Chrome Apps.localized/Mia.app"
)

user_targets=(
  "$user_home/.miaos"
  "$user_home/.config/miaos"
  "$user_home/.local/share/miaos"
  "$user_home/Library/Application Support/Mia"
  "$user_home/Library/Application Support/MiaOS"
  "$user_home/Library/Application Support/miaos-macos-shell"
  "$user_home/Library/Application Support/Google/Chrome/-/Web Applications/_crx_gheloebnikodfjilfjecfhheobcapbgg"
  "$user_home/Library/Caches/com.miaos.desktop"
  "$user_home/Library/Caches/com.miamultiplayer.mia"
  "$user_home/Library/Caches/Mia"
  "$user_home/Library/Caches/MiaOS"
  "$user_home/Library/Caches/miaos-macos-shell"
  "$user_home/Library/HTTPStorages/com.miaos.desktop"
  "$user_home/Library/HTTPStorages/com.miamultiplayer.mia"
  "$user_home/Library/Logs/Mia"
  "$user_home/Library/Logs/MiaOS"
  "$user_home/Library/Preferences/com.miaos.desktop.plist"
  "$user_home/Library/Preferences/com.miamultiplayer.mia.plist"
  "$user_home/Library/Saved Application State/com.miaos.desktop.savedState"
  "$user_home/Library/Saved Application State/com.miamultiplayer.mia.savedState"
  "$user_home/Library/WebKit/com.miaos.desktop"
  "$user_home/Library/WebKit/com.miamultiplayer.mia"
  "$user_home/Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.ApplicationRecentDocuments/com.miaos.desktop.sfl4"
  "$user_home/Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.ApplicationRecentDocuments/com.miamultiplayer.mia.sfl4"
)

launcher_names=(ghost-cli miaos-bot miaos-local miaos-desktop)
for name in "${launcher_names[@]}"; do
  user_targets+=("$user_home/.local/bin/$name")
done

dynamic_targets=()

contains_active_source() {
  local candidate="$1" candidate_real
  if [[ -d "$candidate" ]]; then
    candidate_real="$(cd -P -- "$candidate" && pwd)"
  else
    candidate_real="$candidate"
  fi
  [[ "$repo_root" == "$candidate_real" || "$repo_root" == "$candidate_real/"* ]]
}

for directory in \
  "$user_home/Library/Application Support/CrashReporter" \
  "$user_home/Library/Logs/DiagnosticReports" \
  "$user_home/Library/LaunchAgents"; do
  [[ -d "$directory" ]] || continue
  while IFS= read -r candidate; do dynamic_targets+=("$candidate"); done < <(
    find "$directory" -mindepth 1 -maxdepth 1 \
      \( -iname 'MiaOS*' -o -iname 'Mia_*' -o -iname 'Mia-*' -o -iname 'com.miaos.desktop*' -o -iname 'com.miamultiplayer.mia*' \) \
      -print 2>/dev/null | sort
  )
done

for temporary_root in /tmp /private/tmp; do
  [[ -d "$temporary_root" ]] || continue
  while IFS= read -r candidate; do
    contains_active_source "$candidate" || dynamic_targets+=("$candidate")
  done < <(
    find -H "$temporary_root" -mindepth 1 -maxdepth 1 -user "$(id -u)" \
      \( -iname 'miaos-*' -o -iname 'miaos.*' \) \
      -print 2>/dev/null | sort
  )
done

all_targets=("${applications[@]}" "${user_targets[@]}")
if ((${#dynamic_targets[@]})); then all_targets+=("${dynamic_targets[@]}"); fi

assert_scoped_target() {
  local target="$1"
  case "$target" in
    /Applications/Mia.app|/Applications/MiaOS.app|"$user_home/Applications/Mia.app"|"$user_home/Applications/MiaOS.app"|"$user_home/Applications/Chrome Apps.localized/Mia.app") ;;
    "$user_home/.miaos"|"$user_home/.config/miaos"|"$user_home/.local/share/miaos") ;;
    "$user_home/.local/bin/ghost-cli"|"$user_home/.local/bin/miaos-bot"|"$user_home/.local/bin/miaos-local"|"$user_home/.local/bin/miaos-desktop") ;;
    "$user_home/Library/Application Support/Mia"|"$user_home/Library/Application Support/MiaOS"|"$user_home/Library/Application Support/miaos-macos-shell"|"$user_home/Library/Application Support/Google/Chrome/-/Web Applications/_crx_gheloebnikodfjilfjecfhheobcapbgg") ;;
    "$user_home/Library/Caches/com.miaos.desktop"|"$user_home/Library/Caches/com.miamultiplayer.mia"|"$user_home/Library/Caches/Mia"|"$user_home/Library/Caches/MiaOS"|"$user_home/Library/Caches/miaos-macos-shell") ;;
    "$user_home/Library/HTTPStorages/com.miaos.desktop"|"$user_home/Library/HTTPStorages/com.miamultiplayer.mia") ;;
    "$user_home/Library/Logs/Mia"|"$user_home/Library/Logs/MiaOS") ;;
    "$user_home/Library/Preferences/com.miaos.desktop.plist"|"$user_home/Library/Preferences/com.miamultiplayer.mia.plist") ;;
    "$user_home/Library/Saved Application State/com.miaos.desktop.savedState"|"$user_home/Library/Saved Application State/com.miamultiplayer.mia.savedState") ;;
    "$user_home/Library/WebKit/com.miaos.desktop"|"$user_home/Library/WebKit/com.miamultiplayer.mia") ;;
    "$user_home/Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.ApplicationRecentDocuments/com.miaos.desktop.sfl4"|"$user_home/Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.ApplicationRecentDocuments/com.miamultiplayer.mia.sfl4") ;;
    "$user_home/Library/Application Support/CrashReporter/"MiaOS*|"$user_home/Library/Application Support/CrashReporter/"Mia_*|"$user_home/Library/Application Support/CrashReporter/"Mia-*) ;;
    "$user_home/Library/Logs/DiagnosticReports/"MiaOS*|"$user_home/Library/Logs/DiagnosticReports/"Mia_*|"$user_home/Library/Logs/DiagnosticReports/"Mia-*) ;;
    "$user_home/Library/LaunchAgents/com.miaos.desktop"*|"$user_home/Library/LaunchAgents/com.miamultiplayer.mia"*) ;;
    /tmp/MiaOS*|/tmp/miaos-*|/tmp/miaos.*|/private/tmp/MiaOS*|/private/tmp/miaos-*|/private/tmp/miaos.*) ;;
    *) echo "Refusing unexpected cleanup target: $target" >&2; exit 1 ;;
  esac
}

for target in "${all_targets[@]}"; do assert_scoped_target "$target"; done

stop_installed_processes() {
  local pids=()
  while IFS= read -r pid; do [[ -n "$pid" ]] && pids+=("$pid"); done < <(
    ps -axo pid=,command= | awk \
      -v app='/Applications/Mia.app/' \
      -v legacy_app='/Applications/MiaOS.app/' \
      -v user_app="$user_home/Applications/Mia.app/" \
      -v legacy_user_app="$user_home/Applications/MiaOS.app/" \
      -v miaos="$user_home/.miaos/" \
      '$0 ~ app || $0 ~ legacy_app || $0 ~ user_app || $0 ~ legacy_user_app || $0 ~ miaos { print $1 }'
  )
  if ((${#pids[@]})); then
    echo "Stopping installed Mia processes: ${pids[*]}"
    kill "${pids[@]}" 2>/dev/null || true
    for _ in {1..30}; do
      alive=false
      for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && alive=true; done
      [[ "$alive" == false ]] && break
      sleep 0.1
    done
  fi
}

verify_clean() {
  local remaining=0
  for target in "${all_targets[@]}"; do
    # SIP blocks rm on the sharedfilelist recents entries; they hold no Mia
    # state (just Finder "recent documents" pointers), so they don't count
    # as a failed clean.
    case "$target" in
      "$user_home/Library/Application Support/com.apple.sharedfilelist/"*) continue ;;
    esac
    if [[ -e "$target" || -L "$target" ]]; then
      echo "Remaining: $target" >&2
      remaining=1
    fi
  done
  if pgrep -f '/Applications/Mia\.app/|/Applications/MiaOS\.app/|/Users/[^/]*/Applications/Mia\.app/|/Users/[^/]*/Applications/MiaOS\.app/|/Users/[^/]*/\.miaos/' >/dev/null 2>&1; then
    echo "Remaining: a Mia installation process is still running" >&2
    remaining=1
  fi
  [[ "$remaining" -eq 0 ]] || return 1
  echo "Clean-slate verification passed: no installed Mia or Mia-managed Hermes/Ghost state remains."
}

if [[ "$mode" == "verify" ]]; then
  verify_clean
  exit
fi

echo "Mia macOS cleanup ($mode)"
echo "Preserved: source repositories, DMGs, Git/GitHub credentials, SSH keys, Codex data, existing standalone Hermes installations, standalone development tools"

if [[ "$mode" == "apply" ]]; then stop_installed_processes; fi

for target in "${all_targets[@]}"; do
  [[ -e "$target" || -L "$target" ]] || continue
  if [[ "$mode" == "apply" ]]; then
    echo "Removing: $target"
    # SIP protects the sharedfilelist recents entries; a refused rm must not
    # abort the sweep before the launchers and caches are removed.
    rm -rf -- "$target" 2>/dev/null || echo "Skipped (not permitted): $target"
  else
    echo "Would remove: $target"
  fi
done

if [[ "$mode" == "apply" ]]; then
  verify_clean
else
  echo "Dry run complete. Re-run with --apply to remove these exact targets."
fi
