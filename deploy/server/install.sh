#!/bin/sh
# EnsoCode Server 安装 / 升级（systemd）：
#   curl -fsSL https://github.com/J3n5en/EnsoCode/releases/latest/download/enso-server-install.sh | sudo sh
# 可选环境变量：ENSO_INSTALL_DIR ENSO_DATA_DIR ENSO_USER ENSO_RELEASE_URL ENSO_UPDATE_REPO
set -eu
REPO=${ENSO_UPDATE_REPO:-J3n5en/EnsoCode}
PREFIX=${ENSO_INSTALL_DIR:-/opt/enso-server}
DATA=${ENSO_DATA_DIR:-/var/lib/enso-server}
SVC_USER=${ENSO_USER:-enso}
BASE=${ENSO_RELEASE_URL:-https://github.com/$REPO/releases/latest/download}

fail() {
  echo "enso-server install: $*" >&2
  exit 1
}
[ "$(id -u)" -eq 0 ] || fail "run as root (sudo)"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required"
case $(uname -m) in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
ASSET=enso-server-linux-$ARCH.tar.gz

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"; else wget -qO "$2" "$1"; fi
}
echo "Downloading $ASSET ..."
fetch "$BASE/$ASSET" "$TMP/$ASSET"
fetch "$BASE/enso-server-checksums.txt" "$TMP/checksums"
(cd "$TMP" && grep -E "[ *]$ASSET\$" checksums | sed 's/ \*/  /' | sha256sum -c -) >/dev/null ||
  fail "checksum mismatch for $ASSET"
mkdir "$TMP/bundle"
tar -xzf "$TMP/$ASSET" -C "$TMP/bundle"
VERSION=$(cat "$TMP/bundle/VERSION")

id -u "$SVC_USER" >/dev/null 2>&1 ||
  useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$PREFIX/releases" "$DATA"
rm -rf "$PREFIX/releases/$VERSION"
mv "$TMP/bundle" "$PREFIX/releases/$VERSION"
if [ -L "$PREFIX/current" ] && [ "$(readlink "$PREFIX/current")" != "releases/$VERSION" ]; then
  ln -sfn "$(readlink "$PREFIX/current")" "$PREFIX/.previous" && mv -fT "$PREFIX/.previous" "$PREFIX/previous"
fi
ln -sfn "releases/$VERSION" "$PREFIX/.current" && mv -fT "$PREFIX/.current" "$PREFIX/current"
rm -f "$PREFIX/boot-attempts" "$PREFIX/failed-version"
[ -f "$PREFIX/env" ] || printf 'ENSO_DATA_DIR=%s\n# ENSO_RELAY_URL=https://relay.example.com\n' "$DATA" >"$PREFIX/env"
chown -R "$SVC_USER:" "$PREFIX" "$DATA"

sed -e "s#/opt/enso-server#$PREFIX#g" -e "s#/var/lib/enso-server#$DATA#g" \
  -e "s#^User=.*#User=$SVC_USER#" -e "s#^Group=.*#Group=$(id -gn "$SVC_USER")#" \
  "$PREFIX/current/share/enso-server.service" >/etc/systemd/system/enso-server.service
ln -sfn "$PREFIX/current/bin/enso-server" /usr/local/bin/enso-server
systemctl daemon-reload
systemctl enable enso-server >/dev/null 2>&1
systemctl restart enso-server

echo "EnsoCode Server $VERSION installed to $PREFIX (data: $DATA)."
echo "Pair a device:  sudo -u $SVC_USER enso-server pair"
