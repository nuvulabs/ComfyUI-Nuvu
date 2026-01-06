#!/usr/bin/env bash
set -euo pipefail
set -E

# Set log file
INSTALL_LOG="$(pwd)/install.log"
> "$INSTALL_LOG"

log() {
  printf '\n=== %s ===\n' "$1"
}

on_error() {
  local rc=$?
  local line_no=${BASH_LINENO[0]:-}
  local cmd=${BASH_COMMAND:-}
  echo "" >&2
  echo "ERROR: Installer failed (exit $rc) at line $line_no" >&2
  if [ -n "$cmd" ]; then
    echo "Command: $cmd" >&2
  fi
  echo "See log: $INSTALL_LOG" >&2
  if [ -f "$INSTALL_LOG" ]; then
    echo "" >&2
    echo "Last 60 lines of install.log:" >&2
    tail -n 60 "$INSTALL_LOG" >&2 || true
  fi
  exit $rc
}

trap on_error ERR

ensure_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" | tee -a "$INSTALL_LOG"
    exit 1
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMFY_DIR="$SCRIPT_DIR/ComfyUI"
RUN_SCRIPT_NAME="run_comfy.sh"
PYTHON_BIN="${PYTHON_BIN:-python3}"
nuvu_COMPILED_REPO="https://github.com/nuvulabs/ComfyUI-Nuvu.git"

ensure_cmd git

# Ensure python exists; try to install if missing (Debian/Ubuntu)
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  log "Python not detected"
  if command -v apt-get >/dev/null 2>&1; then
    log "Installing python3 and venv via apt-get"
    sudo apt-get update >> "$INSTALL_LOG" 2>&1
    sudo apt-get install -y python3 python3-venv >> "$INSTALL_LOG" 2>&1
    PYTHON_BIN="python3"
  else
    echo "Python is required but was not found. Install python3.10+ and re-run." | tee -a "$INSTALL_LOG"
    exit 1
  fi
fi

ensure_cmd "$PYTHON_BIN"

export PYTHON_KEYRING_BACKEND=keyrings.alt.file.PlaintextKeyring

"$PYTHON_BIN" - <<'PY'
import sys
required = (3, 10)
if sys.version_info < required:
    ver = ".".join(map(str, sys.version_info[:3]))
    raise SystemExit(
        f"Python {required[0]}.{required[1]}+ is required, but {ver} is available."
    )
PY

clone_and_install() {
  local dir="$1"
  local repo="$2"

  echo "Installing $dir custom node..."
  if [ ! -d "$dir" ]; then
    git clone -q "$repo" >> "$INSTALL_LOG" 2>&1
  else
    echo "$dir already present; skipping clone." >> "$INSTALL_LOG" 2>&1
  fi

  if [ -f "$dir/requirements.txt" ]; then
    (cd "$dir" && python -m pip install -q -r requirements.txt >> "$INSTALL_LOG" 2>&1)
  elif [ -f "$dir/req.txt" ]; then
    (cd "$dir" && python -m pip install -q -r req.txt >> "$INSTALL_LOG" 2>&1)
  fi
}

log "Installing system packages"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update >> "$INSTALL_LOG" 2>&1
  sudo apt-get install -y ninja-build >> "$INSTALL_LOG" 2>&1
else
  echo "apt-get not found; install ninja manually for faster builds." >> "$INSTALL_LOG" 2>&1
fi

log "Preparing ComfyUI directory"
if [ ! -d "$COMFY_DIR" ]; then
  echo "Cloning ComfyUI..."
  git clone -q https://github.com/comfyanonymous/ComfyUI.git "$COMFY_DIR" >> "$INSTALL_LOG" 2>&1
else
  echo "ComfyUI already exists at $COMFY_DIR; skipping clone." >> "$INSTALL_LOG" 2>&1
fi

cd "$COMFY_DIR"

log "Creating virtual environment"
if [ ! -d "venv" ]; then
  "$PYTHON_BIN" -m venv venv >> "$INSTALL_LOG" 2>&1
else
  echo "venv already exists; skipping creation." >> "$INSTALL_LOG" 2>&1
fi

# shellcheck disable=SC1091
source "venv/bin/activate"

log "Upgrading pip"
python -m pip install -q --upgrade pip >> "$INSTALL_LOG" 2>&1

log "Installing keyring helpers"
python -m pip install -q keyrings.alt >> "$INSTALL_LOG" 2>&1

log "Installing PyTorch 2.8.0 stack"
python -m pip install -q torch==2.8.0 torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu128 >> "$INSTALL_LOG" 2>&1

log "Installing core ComfyUI dependencies"
python -m pip install -q -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cu128 >> "$INSTALL_LOG" 2>&1

log "Installing SageAttention 2.2.0"
python -m pip install -q sageattention --no-build-isolation >> "$INSTALL_LOG" 2>&1

log "Installing additional custom nodes"
mkdir -p "$COMFY_DIR/custom_nodes"
cd "$COMFY_DIR/custom_nodes"

clone_and_install "ComfyUI-Manager" "https://github.com/Comfy-Org/ComfyUI-Manager.git"
clone_and_install "ComfyUI-Nuvu" "$nuvu_COMPILED_REPO"
clone_and_install "comfyui_controlnet_aux" "https://github.com/Fannovel16/comfyui_controlnet_aux.git"
clone_and_install "ComfyUI-Impact-Pack" "https://github.com/ltdrdata/ComfyUI-Impact-Pack.git"
clone_and_install "rgthree-comfy" "https://github.com/rgthree/rgthree-comfy.git"
clone_and_install "ComfyUI-VideoHelperSuite" "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git"
clone_and_install "RES4LYF" "https://github.com/ClownsharkBatwing/RES4LYF.git"
clone_and_install "ComfyUI-KJNodes" "https://github.com/kijai/ComfyUI-KJNodes.git"

cd "$COMFY_DIR"

log "Creating helper launcher: $RUN_SCRIPT_NAME"
cat > "$RUN_SCRIPT_NAME" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export PYTHON_KEYRING_BACKEND=keyrings.alt.file.PlaintextKeyring
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/venv/bin/activate"
python "$SCRIPT_DIR/main.py" --use-sage-attention --preview-method auto --auto-launch
EOF

chmod +x "$RUN_SCRIPT_NAME"

log "Copying icon file"
ICON_SRC="$COMFY_DIR/custom_nodes/ComfyUI-Nuvu/web/images/NuvuLogo.png"
ICON_DEST="$COMFY_DIR/nuvu.png"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$ICON_DEST" >> "$INSTALL_LOG" 2>&1
else
  echo "Icon file not found at $ICON_SRC. Skipping icon copy." >> "$INSTALL_LOG" 2>&1
fi

log "Creating shortcuts"
DESKTOP_ENTRY_CONTENT="[Desktop Entry]
Version=1.0
Type=Application
Name=Nuvu-ComfyUI
Comment=Launch Nuvu-ComfyUI
Exec=$COMFY_DIR/$RUN_SCRIPT_NAME
Icon=$ICON_DEST
Terminal=true
Categories=Graphics;"

# Create application menu entry
APP_DIR="$HOME/.local/share/applications"
mkdir -p "$APP_DIR"
echo "$DESKTOP_ENTRY_CONTENT" > "$APP_DIR/nuvu-comfyui.desktop"
chmod +x "$APP_DIR/nuvu-comfyui.desktop"

# Create desktop shortcut
DESKTOP_DIR="$HOME/Desktop"
if [ -d "$DESKTOP_DIR" ]; then
  echo "$DESKTOP_ENTRY_CONTENT" > "$DESKTOP_DIR/Nuvu-ComfyUI.desktop"
  chmod +x "$DESKTOP_DIR/Nuvu-ComfyUI.desktop"
  # Mark as trusted on GNOME-based systems
  if command -v gio >/dev/null 2>&1; then
    gio set "$DESKTOP_DIR/Nuvu-ComfyUI.desktop" metadata::trusted true >> "$INSTALL_LOG" 2>&1 || true
  fi
  echo "Created desktop shortcut: $DESKTOP_DIR/Nuvu-ComfyUI.desktop"
fi

# Update desktop database if available
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >> "$INSTALL_LOG" 2>&1 || true
fi

log "All done!"
echo "Use $COMFY_DIR/$RUN_SCRIPT_NAME to launch ComfyUI with ComfyUI-Nuvu."
echo "You can also find 'Nuvu-ComfyUI' in your application menu and on your Desktop."
echo "If you run into issues, check: $INSTALL_LOG"
exit 0

