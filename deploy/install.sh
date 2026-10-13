#!/bin/sh
# 源码树/本地安装入口（单源）：只读当前 package.json 与 deploy/bootstrap.mjs，不固定版本/URL/SHA、不内嵌获取器副本。
# 包内正式入口（install.sh 与 deploy/install.sh）由 scripts/render-install-sh.mjs 从模板＋获取器源＋当前版本渲染。
set -eu
PACKAGE_NAME='dsh-tavern-sqlite-v2'
BOOTSTRAP_REL='deploy/bootstrap.mjs'
SELF_DIR=''
case "$0" in
  */*) SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) ;;
esac
command -v node >/dev/null 2>&1 || { echo '需要已有酒馆使用的Node.js 22.19+；本脚本不另装运行时。' >&2; exit 1; }
# 交给 node 的路径要按它的平台形态给出（Git Bash/MSYS 下用 cygpath，原生 POSIX 原样透传）。
native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    converted=$(cygpath -w -- "$1" 2>/dev/null) || converted=$1
  else
    converted=$1
  fi
  printf '%s' "$converted"
}
# 用户显式 --package 时不覆盖；未给时由本次定位到的包目录补上，保证与当前 manifest/获取器同源。
explicit_package=''
wanted_package=0
previous=''
for argument in "$@"; do
  if [ "$previous" = '--package' ]; then explicit_package=$argument; wanted_package=1; fi
  if [ "$argument" = '--package' ]; then wanted_package=1; fi
  previous=$argument
done
manifest_name() {
  node --input-type=module -e 'import fs from "node:fs";let value;try{value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}if(typeof value.name!=="string"){process.exit(1)}process.stdout.write(value.name)' "$(native_path "$1")/package.json" 2>/dev/null
}
is_package() {
  if [ -z "$1" ]; then return 1; fi
  if [ ! -f "$1/package.json" ]; then return 1; fi
  if [ ! -f "$1/$BOOTSTRAP_REL" ]; then return 1; fi
  if [ "$(manifest_name "$1")" != "$PACKAGE_NAME" ]; then return 1; fi
  return 0
}
PACKAGE_ROOT=''
for candidate in "$SELF_DIR" "$SELF_DIR/.." "$explicit_package"; do
  if is_package "$candidate"; then PACKAGE_ROOT=$(CDPATH= cd -- "$candidate" && pwd); break; fi
done
if [ -z "$PACKAGE_ROOT" ]; then
  echo '未定位本插件包（需 package.json 与 '"$BOOTSTRAP_REL"'）：请在包目录内直接运行本脚本，或加 --package <包目录>。' >&2
  exit 1
fi
if [ "$wanted_package" = 1 ]; then
  exec node "$(native_path "$PACKAGE_ROOT/$BOOTSTRAP_REL")" "$@"
fi
exec node "$(native_path "$PACKAGE_ROOT/$BOOTSTRAP_REL")" "$@" --package "$(native_path "$PACKAGE_ROOT")"
