'use strict';
/**
 * 「历史模拟RPG.exe」的启动脚本（Node 单文件可执行程序 SEA）。
 * exe 里自带 Node 运行环境，玩家电脑上不用装任何东西：
 *   1. 若游戏已在运行（8787 端口有本游戏在答话），直接打开浏览器；
 *   2. 否则在本进程里启动 exe 旁边的 server.js，等服务就绪后打开浏览器；
 *   3. 关掉这个窗口即退出游戏。存档、配置都在 exe 旁边的 data 文件夹里。
 */
const path = require('path');
const http = require('http');
const { createRequire } = require('module');
const { spawn } = require('child_process');

const DIR = path.dirname(process.execPath);
const PORT = Number(process.env.PORT || 8787);
const URL = `http://127.0.0.1:${PORT}/`;

function health() {
  return new Promise(res => {
    const req = http.get(URL + 'api/health', { timeout: 1500 }, r => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
  });
}

function openBrowser() {
  // 打不开浏览器（无图形界面、命令缺失）也不能让游戏崩掉：提示手动打开即可
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', URL]]
    : process.platform === 'darwin' ? ['open', [URL]] : ['xdg-open', [URL]];
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => console.log('（没能自动打开浏览器，请手动打开上面的地址）'));
    p.unref();
  } catch (_) { console.log('（没能自动打开浏览器，请手动打开上面的地址）'); }
}

(async () => {
  process.chdir(DIR);
  console.log('枢引擎 · 历史模拟');
  if (await health()) {
    console.log('游戏已经在运行，正在打开浏览器……');
    openBrowser();
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  const server = path.join(DIR, 'server.js');
  try {
    createRequire(server)(server);
  } catch (e) {
    console.error('启动失败：' + (e && e.message || e));
    console.error('请确认本程序和 server.js、core、public 等文件夹放在同一个目录里。');
    setTimeout(() => process.exit(1), 60000);
    return;
  }
  for (let i = 0; i < 40; i++) {
    if (await health()) break;
    await new Promise(r => setTimeout(r, 250));
  }
  openBrowser();
  console.log(`游戏已启动：${URL}`);
  console.log('浏览器没自动打开的话，手动复制上面的地址打开即可。');
  console.log('关闭本窗口即退出游戏（存档会自动保存）。');
})();
