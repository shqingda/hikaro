#!/bin/sh
# Hikaro standalone installer. No sudo, package manager, or existing Node required.
# curl -fsSL https://github.com/shqingda/hikaro/releases/latest/download/install.sh | sh
set -eu
main() {
  base=${HIKARO_DOWNLOAD_BASE:-https://github.com/shqingda/hikaro/releases/latest/download}
  base=${base%/}
  install_dir=${HIKARO_INSTALL_DIR:-"$HOME/.local/share/hikaro"}
  bin_dir=${HIKARO_BIN_DIR:-"$HOME/.local/bin"}
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform=darwin-arm64 ;;
    *) echo 'This release supports macOS Apple Silicon only.' >&2; exit 1 ;;
  esac
  for tool in curl tar shasum; do
    command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
  done
  owned_link() {
    dest=$(readlink "$1" 2>/dev/null || true)
    [ "$dest" = "$install_dir/current/bin/hikaro" ]
  }
  claim() {
    link=$bin_dir/$1
    if [ -e "$link" ] || [ -L "$link" ]; then
      owned_link "$link" || { echo "Refusing to replace an unrelated command: $link" >&2; exit 1; }
    fi
  }
  claim hikaro
  claim hk
  umask 077
  mkdir -p "$install_dir/releases" "$bin_dir"
  staging=$(mktemp -d "$install_dir/.install.XXXXXX")
  trap 'rm -rf "$staging"' EXIT
  trap 'exit 1' HUP INT TERM
  printf 'Checking latest Hikaro release…\n'
  curl -fsSL --retry 3 "$base/latest-$platform.txt" -o "$staging/manifest"
  read -r release checksum asset < "$staging/manifest"
  case "$release" in ''|*[!a-zA-Z0-9.-]*) echo 'Invalid release identifier' >&2; exit 1 ;; esac
  case "$checksum" in ''|*[!a-f0-9]*) echo 'Invalid checksum' >&2; exit 1 ;; esac
  [ "${#checksum}" -eq 64 ] || { echo 'Invalid checksum' >&2; exit 1; }
  case "$asset" in "hikaro-$release-$platform.tar.gz") ;; *) echo 'Invalid archive name' >&2; exit 1 ;; esac
  previous=$(readlink "$install_dir/current" 2>/dev/null || true)
  if [ "$previous" = "$install_dir/releases/$release" ] && [ -x "$previous/bin/hikaro" ]; then
    printf 'Hikaro %s is already installed.\n' "$release"
  else
    printf 'Downloading Hikaro %s…\n' "$release"
    curl -fL --progress-bar --retry 3 "$base/$asset" -o "$staging/package.tar.gz"
    printf 'Verifying download…\n'
    actual=$(shasum -a 256 "$staging/package.tar.gz")
    [ "${actual%% *}" = "$checksum" ] || { echo 'Download checksum mismatch; installation unchanged.' >&2; exit 1; }
    printf 'Extracting package…\n'
    mkdir "$staging/package"
    tar -xzf "$staging/package.tar.gz" -C "$staging/package"
    # Remove Gatekeeper quarantine copied from the download, if any.
    xattr -dr com.apple.quarantine "$staging/package" 2>/dev/null || true
    "$staging/package/runtime/bin/node" "$staging/package/app/node_modules/hikaro/dist/hikaro.mjs" --version >/dev/null
    destination="$install_dir/releases/$release"
    rm -rf "$destination"
    mv "$staging/package" "$destination"
  fi
  destination="$install_dir/releases/$release"
  printf 'Activating installed version…\n'
  "$destination/runtime/bin/node" -e 'const fs=require("node:fs"),path=require("node:path");const [dir,tmp,bin,base]=process.argv.slice(1);fs.writeFileSync(tmp,JSON.stringify({binDir:path.resolve(bin),base}),{mode:0o600});fs.renameSync(tmp,path.join(dir,"install.json"))' "$install_dir" "$staging/install.json" "$bin_dir" "${HIKARO_DOWNLOAD_BASE:-}"
  ln -s "$destination" "$staging/current"
  # rename(2) swaps the symlink atomically; a running hikaro keeps its open release.
  "$destination/runtime/bin/node" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$staging/current" "$install_dir/current"
  ln -sfn "$install_dir/current/bin/hikaro" "$bin_dir/hikaro"
  ln -sfn "$install_dir/current/bin/hikaro" "$bin_dir/hk"
  # Keep the active and the previous release for rollback; remove older ones.
  for old in "$install_dir"/releases/*; do
    [ -d "$old" ] || continue
    [ "$old" = "$destination" ] || [ "$old" = "$previous" ] || rm -rf "$old"
  done
  if [ "${HIKARO_NO_MODIFY_PATH:-0}" != 1 ] && [ "$bin_dir" = "$HOME/.local/bin" ]; then
    case ":$PATH:" in
      *":$bin_dir:"*) ;;
      *)
        for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
          [ -f "$profile" ] || [ "$profile" = "$HOME/.zshrc" ] || continue
          grep -Fq '# Hikaro CLI' "$profile" 2>/dev/null ||
            printf '\n# Hikaro CLI\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$profile"
        done
        ;;
    esac
  fi
  printf '\nHikaro %s installed. Run: hikaro (or hk)\n' "$release"
  case ":$PATH:" in *":$bin_dir:"*) ;; *) printf 'Open a new terminal first, or run: %s/hikaro\n' "$bin_dir" ;; esac
  printf 'Update later with: hikaro update\n'
}
main "$@"
