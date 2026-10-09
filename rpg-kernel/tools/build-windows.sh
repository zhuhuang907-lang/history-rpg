#!/usr/bin/env bash
# 生成 Windows 免安装版：历史模拟RPG-Windows.zip
# 做法：Node 官方 win-x64 运行环境 + Node「单文件可执行程序」(SEA) 注入启动脚本 → 历史模拟RPG.exe
# 需要：Linux/macOS 上的 Node 22（与下面 NODE_VER 同一主版本）、npx、curl、python3
set -euo pipefail
NODE_VER="${NODE_VER:-v22.22.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/../dist}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -sSLo node.zip "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-win-x64.zip"
curl -sSL "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt" | grep " node-$NODE_VER-win-x64.zip\$" | sed "s/node-$NODE_VER-win-x64.zip/node.zip/" | sha256sum -c -
python3 -c "import zipfile;z=zipfile.ZipFile('node.zip');n=[x for x in z.namelist() if x.endswith('/node.exe')][0];open('node.exe','wb').write(z.read(n))"

cp "$ROOT/launcher/sea-launcher.js" launcher.js
printf '{"main":"launcher.js","output":"sea.blob","disableExperimentalSEAWarning":true,"useCodeCache":false}' > sea.json
node --experimental-sea-config sea.json
cp node.exe game.exe
FUSE="$(grep -ao 'NODE_SEA_FUSE_[0-9a-f]*' node.exe | head -1)"   # 从二进制里读，避免写死
npx --yes postject@1.0.0-alpha.6 game.exe NODE_SEA_BLOB sea.blob --sentinel-fuse "$FUSE" >/dev/null

PKG="$WORK/历史模拟RPG"
mkdir -p "$PKG"
# 只带运行所需：源码、页面、规则包、提示词、史料数据；不带自测脚本与开发文档
for x in server.js package.json core adapters public rulepacks prompts wordlists data README.md; do
  if [ -e "$ROOT/$x" ]; then cp -r "$ROOT/$x" "$PKG/"; fi
done
rm -rf "$PKG/data/saves" "$PKG/data/cache" "$PKG/data/search.json" "$PKG/data/adapter-config.json"
cp game.exe "$PKG/历史模拟RPG.exe"
cat > "$PKG/先看我.txt" <<'TXT'
历史模拟RPG · 免安装版

怎么玩：双击「历史模拟RPG.exe」，会弹出一个黑色窗口并自动打开浏览器。
退出：关掉那个黑色窗口即可（存档自动保存在 data 文件夹）。

第一次运行：
· Windows 可能提示「已保护你的电脑」：点「更多信息」→「仍要运行」（本程序未做商业签名）。
· 防火墙若询问网络权限，选「允许」（游戏要联网检索史料、调用 AI）。
· 进游戏后点右上「设置」，填 DeepSeek 的 API Key（platform.deepseek.com 申请）。

升级：把新版解压到别处，再把旧版的 data 文件夹整个拷过去覆盖，存档与设置就都在了。
TXT
mkdir -p "$OUT"
( cd "$WORK" && python3 - "$OUT/历史模拟RPG-Windows.zip" <<'PY'
import os, sys, zipfile
out = sys.argv[1]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for r, d, f in os.walk('历史模拟RPG'):
        for x in f:
            p = os.path.join(r, x)
            z.write(p, p)   # Python 写入的中文文件名带 UTF-8 标记，Windows 解压不会乱码
print(out)
PY
)
