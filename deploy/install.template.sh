#!/bin/sh
# 发行 SH 模板（唯一来源）：由 scripts/render-install-sh.mjs 连同 deploy/bootstrap.mjs 与当前 package.json 版本渲染成
# 包内二入口（install.sh、deploy/install.sh，URL/SHA 保持占位，避免内嵌本次 tgz 摘要自引用）与外部发行件（地址与摘要只填一次）。
# 源码树两入口不是本模板的产物，而是只读当前 manifest/bootstrap 的本地 wrapper；三者不得各写一份实现。
set -eu
RELEASE_URL='__DSH_RELEASE_URL__'
RELEASE_SHA256='__DSH_RELEASE_SHA256__'
VERSION='__DSH_RELEASE_VERSION__'
SCRIPT_DIR=''
case "$0" in
  *install.sh) SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) ;;
esac
export DSH_STORAGE_BOOTSTRAP_DIR="$SCRIPT_DIR"
export DSH_STORAGE_RELEASE_URL="${DSH_STORAGE_RELEASE_URL:-$RELEASE_URL}"
export DSH_STORAGE_RELEASE_SHA256="${DSH_STORAGE_RELEASE_SHA256:-$RELEASE_SHA256}"
export DSH_STORAGE_RELEASE_VERSION="$VERSION"
command -v node >/dev/null 2>&1 || { echo '需要已有酒馆使用的Node.js 22.19+；本脚本不另装运行时。' >&2; exit 1; }
node --input-type=module - "$@" <<'DSH_STORAGE_BOOTSTRAP'
__DSH_BOOTSTRAP_SOURCE__
DSH_STORAGE_BOOTSTRAP
