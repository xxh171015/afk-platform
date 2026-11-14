// GET /setup.sh: what a person runs in the planning repo, copied from the control tower, to get this machine ready to
// plan (#322). It asks nothing and reaches only the platform: it names everything missing at once and changes nothing
// then; otherwise it puts the platform's plat on PATH, has plat remember the platform's address, and runs plat sync,
// which writes afk-setup and the planning skills into the repo from the copy plat carries. Running it again is safe.
// POSIX sh, for macOS and Linux.

const quoted = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** The script, for the platform that answers at `address` (the address the person fetched it from). */
export function setupScript(address: string): string {
  return `#!/bin/sh
# Gets this machine ready to plan with the AFK platform at ${address.replace(/\n/g, "")}.
# Run it in the planning repo: curl -fsSL <platform>/setup.sh | sh
set -u
platform=${quoted(address)}

missing=""
need() { missing="$missing  - $1
"; }

top=""
if command -v git >/dev/null 2>&1; then
  top=$(git rev-parse --show-toplevel 2>/dev/null) || top=""
  [ -n "$top" ] || need "run this in the planning repo: $(pwd) is not a git checkout"
else
  need "git: xcode-select --install (macOS), or your package manager"
fi
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 20 ] 2>/dev/null || need "Node 20 or newer (this is $(node --version)): brew install node, or the installer from nodejs.org"
else
  need "Node 20 or newer: brew install node, or the installer from nodejs.org"
fi
if [ -n "$missing" ]; then
  printf 'This machine is not ready to plan with the platform; nothing was changed. Missing:\\n%s' "$missing" >&2
  exit 1
fi

# plat goes into a directory already on PATH that is under the home directory and writable: ~/.local/bin, then
# ~/bin, then any other. Only when there is none: ~/.local/bin, with one line in the shell's configuration.
on_path() { case ":$PATH:" in *":$1:"*) [ -d "$1" ] && [ -w "$1" ];; *) return 1;; esac; }
dir=""
for candidate in "$HOME/.local/bin" "$HOME/bin"; do
  if [ -z "$dir" ] && on_path "$candidate"; then dir=$candidate; fi
done
if [ -z "$dir" ]; then
  old_ifs=$IFS
  IFS=:
  for candidate in $PATH; do
    case "$candidate" in
      "$HOME"/*) if [ -z "$dir" ] && [ -d "$candidate" ] && [ -w "$candidate" ]; then dir=$candidate; fi ;;
    esac
  done
  IFS=$old_ifs
fi
added=""
if [ -z "$dir" ]; then
  dir="$HOME/.local/bin"
  mkdir -p "$dir"
  case "\${SHELL:-}" in
    */zsh) rc="$HOME/.zshrc" ;;
    */bash) rc="$HOME/.bashrc" ;;
    *) rc="$HOME/.profile" ;;
  esac
  line='export PATH="$HOME/.local/bin:$PATH"'
  if ! grep -qxF "$line" "$rc" 2>/dev/null; then
    printf '\\n%s\\n' "$line" >>"$rc"
    added=$rc
  fi
fi

if ! curl -fsSL "$platform/cli/plat.mjs" -o "$dir/plat.next"; then
  rm -f "$dir/plat.next"
  echo "could not download plat from $platform/cli/plat.mjs" >&2
  exit 1
fi
chmod +x "$dir/plat.next"
mv "$dir/plat.next" "$dir/plat"
echo "plat: installed in $dir"
[ -z "$added" ] || echo "plat: added $dir to PATH in $added (open a new terminal for it)"

"$dir/plat" connect "$platform" || exit 1
(cd "$top" && "$dir/plat" sync) || exit 1

echo
echo "Next: open this repo in Cursor or Claude Code and type /afk-setup"
`;
}
