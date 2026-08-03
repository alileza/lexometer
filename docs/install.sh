#!/bin/sh
# tokometer installer — downloads the right prebuilt binary from GitHub Releases.
#
#   curl -fsSL https://tokometer.apps.alileza.me/install.sh | sh
#
# Env overrides:
#   VERSION=v0.1.0   install a specific tag (default: latest release)
#   BIN_DIR=~/bin    install location (default: /usr/local/bin, else ~/.local/bin)
set -eu

REPO="alileza/tokometer"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar  >/dev/null 2>&1 || die "tar is required"

# --- detect platform ---
os=$(uname -s)
case "$os" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "unsupported OS: $os (Windows: download the .zip from the Releases page)" ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64)  ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "unsupported architecture: $arch" ;;
esac

# --- resolve version ---
TAG="${VERSION:-}"
if [ -z "$TAG" ]; then
  TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name"' | head -n1 | cut -d'"' -f4)
  [ -n "$TAG" ] || die "could not determine the latest release — is one published yet? Set VERSION=vX.Y.Z to pin one."
fi
VER="${TAG#v}" # archive names drop the leading v

URL="https://github.com/$REPO/releases/download/$TAG/tokometer_${VER}_${OS}_${ARCH}.tar.gz"

# --- choose an install dir we can write to ---
if [ -n "${BIN_DIR:-}" ]; then
  :
elif [ -w /usr/local/bin ] 2>/dev/null; then
  BIN_DIR=/usr/local/bin
else
  BIN_DIR="$HOME/.local/bin"
fi
mkdir -p "$BIN_DIR"

# --- download + extract ---
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
say "Downloading tokometer $TAG ($OS/$ARCH)…"
curl -fSL "$URL" -o "$tmp/tokometer.tar.gz" \
  || die "download failed: $URL"
tar -xzf "$tmp/tokometer.tar.gz" -C "$tmp"
install -m 0755 "$tmp/tokometer" "$BIN_DIR/tokometer" 2>/dev/null \
  || { mv "$tmp/tokometer" "$BIN_DIR/tokometer"; chmod 0755 "$BIN_DIR/tokometer"; }

say "Installed $("$BIN_DIR/tokometer" --version) → $BIN_DIR/tokometer"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) say ""; say "Add it to your PATH:"; say "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
say "Run: tokometer"
