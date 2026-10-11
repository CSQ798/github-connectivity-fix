#!/usr/bin/env node
/**
 * push-via-api.js —— 当 `git push` 连不上 github.com 时，改走 api.github.com 上传文件
 *
 * 背景
 *   国内的 GitHub 阻断往往是"针对部分 IP 的 443 端口间歇性丢包"。
 *   `github.com` 和 `api.github.com` 走的是**不同**的边缘节点，
 *   因此经常出现"git push 一直超时，但这个脚本能推上去"的情况。
 *
 * 原理
 *   用 GitHub Contents API（PUT /repos/{owner}/{repo}/contents/{path}）逐个上传文件。
 *   关键点：TCP 目标可以换成实测可用的 IP，但 TLS 的 SNI 和 HTTP 的 Host
 *          必须保持 api.github.com —— 否则 GitHub 边缘节点会返回 400 / 301。
 *
 * 用法
 *   1. 设置环境变量（token 需要 repo 权限）：
 *        Windows PowerShell:
 *          $env:GH_TOK = "<你的 Personal Access Token>"
 *        macOS / Linux:
 *          export GH_TOK=<你的 Personal Access Token>
 *   2. 在仓库根目录执行：
 *        node push-via-api.js CSQ798/github-connectivity-fix
 *      可选：指定提交说明
 *        node push-via-api.js CSQ798/github-connectivity-fix "fix: 更新 IP 列表"
 *
 * 说明
 *   - 只上传 git 已跟踪的文件（git ls-files），不会误传临时文件
 *   - 需要本地已安装 git 与 node
 *   - 这是 `git push` 的补充手段，不是替代品；网络正常时优先用 git push
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { execFileSync } = require('child_process');

const repo = process.argv[2];
const message = process.argv[3] || 'chore: 通过 API 同步更新';
const token = process.env.GH_TOK;
const branch = process.env.GH_BRANCH || 'main';
const dir = process.cwd();

// 候选 IP 来自 https://api.github.com/meta 的 web 字段
const CANDIDATES = (process.env.GH_IPS ||
  '20.205.243.168,20.27.177.113,140.82.112.3,20.205.243.160,20.200.245.247,20.205.243.166'
).split(',').map(s => s.trim()).filter(Boolean);

if (!repo) {
  console.error('用法: node push-via-api.js <owner>/<repo> ["提交说明"]');
  process.exit(1);
}
if (!token) {
  console.error('[X] 请先设置环境变量 GH_TOK（Personal Access Token，需 repo 权限）');
  process.exit(1);
}

let listIndex = 0;

/** 固定 TCP 目标 IP，但保持 SNI/Host 为 api.github.com */
class PinnedAgent extends https.Agent {
  constructor(ip) { super({ keepAlive: false }); this.ip = ip; }
  createConnection(options, cb) {
    const o = Object.assign({}, options);
    o.host = this.ip;
    o.servername = 'api.github.com';
    const socket = tls.connect(o);
    socket.once('secureConnect', () => cb(null, socket));
    socket.once('error', (err) => cb(err));
  }
}

function request(method, urlPath, body, ip) {
  return new Promise((resolve) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const opts = {
      hostname: 'api.github.com',
      port: 443,
      path: urlPath,
      method,
      headers: Object.assign({
        'User-Agent': 'push-via-api',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'token ' + token
      }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
    };
    if (ip) opts.agent = new PinnedAgent(ip);
    const req = https.request(opts, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve({ code: r.statusCode, body: d }));
    });
    req.on('error', e => resolve({ code: 0, body: e.code || e.message }));
    req.setTimeout(25000, () => { resolve({ code: 0, body: 'socket timeout' }); req.destroy(); });
    if (data) req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function nextTarget() {
  if (listIndex === 0) return null;                 // 第一档：走系统 DNS
  return CANDIDATES[(listIndex - 1) % CANDIDATES.length];
}
function advance() {
  listIndex++;
  if (listIndex > CANDIDATES.length) listIndex = 0;
}

/** 带换 IP 重试的 API 调用（阻断是间歇性的，失败就换目标） */
async function api(method, urlPath, body, label, tolerate404) {
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 40; attempt++) {
    const ip = nextTarget();
    const r = await request(method, urlPath, body, ip);
    if (r.code >= 200 && r.code < 300) return JSON.parse(r.body || '{}');
    if (tolerate404 && r.code === 404) return null;
    if (r.code === 0 || r.code === 301 || r.code === 400 || r.code >= 500) {
      lastErr = 'HTTP ' + r.code + ' ' + String(r.body).slice(0, 80);
      advance();
      await sleep(1200);
      continue;
    }
    throw new Error(`${label} -> HTTP ${r.code}: ${String(r.body).slice(0, 400)}`);
  }
  throw new Error(`${label} 重试 40 次仍失败，最后错误: ${lastErr}`);
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

(async () => {
  console.error('[i] 目标仓库: ' + repo + '  分支: ' + branch);
  const me = await api('GET', '/user', null, 'GET /user');
  console.error('[i] 认证身份: ' + me.login);

  const files = trackedFiles();
  console.error('[i] git 已跟踪文件数: ' + files.length);

  let uploaded = 0;
  for (const relPath of files) {
    const full = path.join(dir, relPath);
    if (!fs.existsSync(full)) { console.error('[!] 跳过不存在的文件: ' + relPath); continue; }

    const buf = fs.readFileSync(full);
    const urlPath = `/repos/${repo}/contents/${relPath.split('/').map(encodeURIComponent).join('/')}`;

    let sha = null;
    const existing = await api('GET', urlPath + '?ref=' + branch, null, 'GET ' + relPath, true);
    if (existing && existing.sha) sha = existing.sha;

    const payload = { message, content: buf.toString('base64'), branch };
    if (sha) payload.sha = sha;

    await api('PUT', urlPath, payload, 'PUT ' + relPath);
    uploaded++;
    console.error('  ' + (sha ? '更新' : '新建') + '  ' + relPath + '  (' + buf.length + ' bytes)');
  }

  console.error('\n[OK] 已上传 ' + uploaded + ' 个文件到 https://github.com/' + repo);
})().catch(e => { console.error('[X] ' + e.message); process.exit(1); });
