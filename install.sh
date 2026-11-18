#!/usr/bin/env bash
# Install pp without npm: symlink the CLI into ~/.local/bin.
set -euo pipefail

src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="${PI_PLUS_BIN_DIR:-$HOME/.local/bin}"
target="$bin_dir/pp"

command -v node >/dev/null 2>&1 || { echo "error: node not found (need Node.js >= 18)"; exit 1; }
command -v tmux >/dev/null 2>&1 || echo "warning: tmux not found; pp needs tmux at runtime"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<18) { console.error("error: Node.js >= 18 required, found "+process.versions.node); process.exit(1); }'

mkdir -p "$bin_dir"
chmod +x "$src_dir/bin/pp.js"
ln -sfn "$src_dir/bin/pp.js" "$target"

echo "linked $target -> $src_dir/bin/pp.js"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "note: add $bin_dir to PATH, e.g. export PATH=\"$bin_dir:\$PATH\"" ;;
esac
"$target" version
