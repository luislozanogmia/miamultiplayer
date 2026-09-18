#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/clean-local-install.sh [--apply] [--system|--all]

Removes the local Mia preview installation and its bundled Hermes and Ghost runtimes.
The default is a dry run. Pass --apply to perform the cleanup.
Pass --system to target a system-installed .deb instead; applying that mode
requires root and purges the miaos package plus its exact installation paths.
Pass --all with sudo to remove both the system package and the invoking user's
Mia, Hermes, and Ghost runtime state in one clean-slate operation.

This intentionally preserves source repositories, Git configuration, GitHub
authentication, SSH keys, and unrelated applications.
EOF
}

apply=false
system=false
all=false
for arg in "$@"; do
  case "$arg" in
    --apply) apply=true ;;
    --system) system=true ;;
    --all) system=true; all=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

user_home="${HOME:?HOME is required}"
owner_uid="$(id -u)"
if [[ "$all" == true && "$apply" == true ]]; then
  [[ "$EUID" -eq 0 ]] || { echo "Full cleanup requires: sudo $0 --apply --all" >&2; exit 1; }
  [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != root && -n "${SUDO_UID:-}" ]] || {
    echo "Full cleanup must be invoked with sudo by the user whose state should be removed." >&2
    exit 1
  }
  user_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  owner_uid="$SUDO_UID"
fi

if [[ "$system" == true ]]; then
  system_targets=(/opt/miaos /usr/bin/mia /usr/bin/miaos /usr/bin/ghost-cli /usr/lib/miaos /usr/share/applications/miaos.desktop /usr/share/icons/hicolor/512x512/apps/miaos.png)
  echo "Mia system cleanup ($([[ "$apply" == true ]] && echo apply || echo dry-run))"
  if [[ "$apply" == true && "$EUID" -ne 0 ]]; then
    echo "System cleanup requires root. Re-run with: sudo $0 --apply --system" >&2
    exit 1
  fi
  if [[ "$apply" == true ]]; then
    mapfile -t process_ids < <(pgrep -f '^/opt/miaos/' || true)
    if ((${#process_ids[@]})); then
      echo "Stopping packaged runtime processes: ${process_ids[*]}"
      kill "${process_ids[@]}" 2>/dev/null || true
    fi
  fi
  if [[ "$apply" == true ]]; then
    for package_name in mia miaos; do
      if dpkg-query -W -f='${Status}' "$package_name" 2>/dev/null | grep -q 'install ok installed'; then
        dpkg --purge "$package_name"
      fi
    done
  fi
  for target in "${system_targets[@]}"; do
    [[ -e "$target" || -L "$target" ]] || continue
    if [[ "$apply" == true ]]; then
      echo "Removing: $target"
      rm -rf -- "$target"
    else
      echo "Would remove: $target"
    fi
  done
  echo "$([[ "$apply" == true ]] && echo 'System cleanup complete.' || echo 'System dry run complete.')"
  [[ "$all" == true ]] || exit 0
fi

if [[ "$user_home" == "/" || "$user_home" == "." || ! -d "$user_home" ]]; then
  echo "Refusing unsafe HOME: $user_home" >&2
  exit 1
fi

miaos_home="$user_home/.miaos"
local_bin="$user_home/.local/bin"
local_share="$user_home/.local/share"
hermes_home="$local_share/miaos/hermes"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

assert_scoped_path() {
  local target="$1"
  case "$target" in
    "$user_home"/.miaos|"$user_home"/.local/share/miaos) ;;
    *) echo "Refusing unexpected cleanup target: $target" >&2; exit 1 ;;
  esac
}

for target in "$miaos_home" "$local_share/miaos"; do
  assert_scoped_path "$target"
done

declare -a targets=("$miaos_home" "$local_share/miaos")
for name in ghost-cli miaos-bot miaos-local miaos-desktop; do
  targets+=("$local_bin/$name")
done
targets+=("$local_share/applications/miaos.desktop" "$local_share/icons/hicolor/512x512/apps/miaos.png")

mapfile -t preview_dirs < <(find /tmp -mindepth 1 -maxdepth 1 -type d -user "$owner_uid" -name 'miaos-preview.*' -print 2>/dev/null | sort)
targets+=("${preview_dirs[@]}")

echo "Mia local cleanup ($([[ "$apply" == true ]] && echo apply || echo dry-run))"
echo "Preserved: Git repositories, Git/GitHub credentials, SSH keys"

if [[ "$apply" == true ]]; then
  # Stop only local Mia/Hermes processes owned by this user. The executable,
  # working directory, or listening port must match an installation target.
  mapfile -t process_ids < <(
    for proc in /proc/[0-9]*; do
      pid="${proc##*/}"
      [[ "$pid" != "$$" && -r "$proc/cmdline" ]] || continue
      [[ "$(awk '/^Uid:/{print $2}' "$proc/status" 2>/dev/null)" == "$owner_uid" ]] || continue
      cmd="$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)"
      cwd="$(readlink "$proc/cwd" 2>/dev/null || true)"
      if [[ "$cmd" == *"$hermes_home/hermes-agent"* || "$cmd" == *"$local_share/miaos/"* || "$cmd" == /opt/miaos/* ]] ||
         { [[ "$cmd" == *"electron"* ]] && [[ "$cwd" == "$repo_root/macos" ]]; } ||
         { [[ "$cmd" == *"/server.js"* || "$cmd" == *" server.js"* ]] &&
           [[ "$cwd" == "$repo_root/backend" || "$cwd" == */Mia/backend || "$cwd" == */Mia/*/backend || "$cwd" == "$local_share/miaos"/*/backend ]]; }; then
        echo "$pid"
      fi
    done | sort -nu
  )
  if ((${#process_ids[@]})); then
    echo "Stopping matching runtime processes: ${process_ids[*]}"
    kill "${process_ids[@]}" 2>/dev/null || true
    for _ in {1..20}; do
      alive=false
      for pid in "${process_ids[@]}"; do kill -0 "$pid" 2>/dev/null && alive=true; done
      [[ "$alive" == false ]] && break
      sleep 0.1
    done
  fi
fi

for target in "${targets[@]}"; do
  [[ -e "$target" || -L "$target" ]] || continue
  case "$target" in
    /tmp/miaos-preview.*) ;;
    "$miaos_home"|"$local_share/miaos"|"$local_share/applications/miaos.desktop"|"$local_share/icons/hicolor/512x512/apps/miaos.png"|"$local_bin/ghost-cli"|"$local_bin/miaos-bot"|"$local_bin/miaos-local"|"$local_bin/miaos-desktop") ;;
    *) echo "Refusing unexpected target: $target" >&2; exit 1 ;;
  esac
  if [[ "$apply" == true ]]; then
    echo "Removing: $target"
    rm -rf -- "$target"
  else
    echo "Would remove: $target"
  fi
done

if [[ "$apply" == true ]]; then
  echo "Cleanup complete. Runtime state and file-backed provider credentials are absent."
else
  echo "Dry run complete. Re-run with --apply to remove these exact targets."
fi
