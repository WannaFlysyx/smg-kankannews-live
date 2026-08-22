// ==UserScript==
// @name         看看新闻直播一键播放版
// @namespace    http://tampermonkey.net/
// @author       https://github.com/WannaFlysyx         
// @version      2.5
// @description  收看看看新闻相关内容
// @match        *://*.kankanews.com/*
// @updateURL    https://github.com/WannaFlysyx/smg-kankannews-live/raw/refs/heads/main/smg-wxty.user.js
// @downloadURL  https://github.com/WannaFlysyx/smg-kankannews-live/raw/refs/heads/main/smg-wxty.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /* ========== RSA 公钥参数（保持不变） ========== */
  const N_HEX = 'cfe61ccf516e5115e136c414f5111077847648568b67fea6ad5a181cd5e6687f4f6a2a312514de8d99ae3ad590301a95f869ecca3fc01d8785898f8bb63b9e310970edc33291a993b6a0d664b8d985d956bc90b82211000073161cf0981337eb9040da6c7a9e27fe8d6c02b4c9a28648175ec4b52a928170dc27bc838f9adcef';
  const PUB_N = BigInt('0x' + N_HEX);
  const PUB_E = 65537n;

  /* ========== RSA 解密 ========== */
  function modPow(base, exp, mod) {
    let result = 1n;
    base = base % mod;
    while (exp > 0n) {
      if (exp & 1n) result = (result * base) % mod;
      exp >>= 1n;
      base = (base * base) % mod;
    }
    return result;
  }
  function bytesToBigInt(bytes) {
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    return v;
  }
  function bigIntToBytes(v, len) {
    const out = new Uint8Array(len);
    for (let i = len - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
  }
  function unpadPKCS1(bytes) {
    let i = 0;
    while (i < bytes.length && bytes[i] === 0) i++;
    if (i < bytes.length && (bytes[i] === 1 || bytes[i] === 2)) {
      const sep = bytes.indexOf(0, i + 1);
      if (sep > 0) return bytes.slice(sep + 1);
    }
    while (bytes.length > 0 && bytes[0] === 0) bytes = bytes.slice(1);
    return bytes;
  }
  function decryptLiveAddress(t) {
    if (!t || typeof t !== 'string') return '';
    // 容错：处理 JSON 转义
    t = t.replace(/\\\//g, '/').replace(/\\/g, '').trim();
    const binary = atob(t);
    let hex = '';
    for (let i = 0; i < binary.length; i++) hex += ('0' + binary.charCodeAt(i).toString(16)).slice(-2);
    hex = hex.toUpperCase();
    const chunks = [];
    for (let i = 0; i < hex.length; i += 256) {
      const chunkHex = hex.slice(i, i + 256);
      const chunkBytes = new Uint8Array(chunkHex.length / 2);
      for (let j = 0; j < chunkBytes.length; j++) chunkBytes[j] = parseInt(chunkHex.slice(j * 2, j * 2 + 2), 16);
      const c = bytesToBigInt(chunkBytes);
      const m = modPow(c, PUB_E, PUB_N);
      const padded = bigIntToBytes(m, 128);
      chunks.push(unpadPKCS1(padded));
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { result.set(c, off); off += c.length; }
    return new TextDecoder().decode(result);
  }

  /* ========== 注入页面上下文：只递归查找 live_address ========== */
  function injectInterceptor() {
    const code = `
      (function() {
        function findLiveAddress(obj, path, results) {
          if (!obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) {
            obj.forEach((item, i) => findLiveAddress(item, path + '[' + i + ']', results));
            return;
          }
          for (const key of Object.keys(obj)) {
            const val = obj[key];
            const currentPath = path ? path + '.' + key : key;
            if (/^live_address$/i.test(key) && typeof val === 'string' && val.length > 0) {
              results.push({ value: val, path: currentPath });
            }
            if (typeof val === 'object' && val !== null) {
              findLiveAddress(val, currentPath, results);
            }
          }
        }

        function tryExtractLiveAddress(text) {
          if (typeof text !== 'string') return;
          try {
            const j = JSON.parse(text);
            const matches = [];
            findLiveAddress(j, '', matches);
            if (matches.length > 0) {
              window.postMessage({
                source: 'kklive-interceptor',
                type: 'live_address',
                live_address: matches[0].value,
                channel_name: '直播'
              }, '*');
            }
          } catch (e) {}
        }

        // Hook XHR
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
          this._kklive_url = url;
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
          if (this._kklive_url) {
            this.addEventListener('load', function() {
              tryExtractLiveAddress(this.responseText);
            });
          }
          return origSend.apply(this, arguments);
        };

        // Hook fetch
        const origFetch = window.fetch;
        window.fetch = function(url, opts) {
          return origFetch.apply(this, arguments).then(function(resp) {
            const u = (typeof url === 'string') ? url : (url && url.url);
            if (u) {
              resp.clone().text().then(tryExtractLiveAddress);
            }
            return resp;
          });
        };
      })();
    `;
    const s = document.createElement('script');
    s.textContent = code;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }

  injectInterceptor();

  /* ========== 捕获直播地址 ========== */
  let capturedLive = null;
  let capturedName = '';

  window.addEventListener('message', (e) => {
    if (e.data && e.data.source === 'kklive-interceptor' && e.data.live_address) {
      capturedLive = e.data.live_address;
      capturedName = e.data.channel_name || '直播';
      updateButtonState();
    }
  });

  /* ========== 加载 hls.js ========== */
  function loadHls() {
    return new Promise((resolve, reject) => {
      if (window.Hls) return resolve(window.Hls);
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
      s.onload = () => resolve(window.Hls);
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  /* ========== 极简 UI：悬浮按钮 + 简单面板 ========== */
  let panel = null;
  let floatBtn = null;

  function createPanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'kklive-panel';
    panel.style.cssText = `
      position: fixed; top: 20px; right: 20px; z-index: 999999;
      width: 320px; background: #1a1a2e; color: #eee; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,.5); font-family: -apple-system, sans-serif;
      font-size: 13px; overflow: hidden; border: 1px solid #333;
    `;
    panel.innerHTML = `
      <div style="padding:12px 16px; background:#16213e; display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:600; font-size:14px;">🎬 看看直播播放器</span>
        <span id="kklive-close" style="cursor:pointer; opacity:.6; font-size:18px; line-height:1;">×</span>
      </div>
      <video id="kklive-video" style="width:100%; display:none; background:#000;" controls playsinline></video>
      <div id="kklive-status" style="padding:10px 14px; font-size:12px; opacity:.85; min-height:20px;"></div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#kklive-close').onclick = () => {
      if (panel.querySelector('#kklive-video')._hls) {
        panel.querySelector('#kklive-video')._hls.destroy();
      }
      panel.remove();
      panel = null;
    };

    return panel;
  }

  function setStatus(msg) {
    if (!panel) return;
    const statusEl = panel.querySelector('#kklive-status');
    if (statusEl) statusEl.textContent = msg;
  }

  function updateButtonState() {
    if (!floatBtn) return;
    if (capturedLive) {
      floatBtn.textContent = '▶ 播放直播（已就绪）';
      floatBtn.style.background = '#4ade80';
      floatBtn.style.color = '#000';
    } else {
      floatBtn.textContent = '▶ 直播播放';
      floatBtn.style.background = '#e94560';
      floatBtn.style.color = '#fff';
    }
  }

  function init() {
    // 创建悬浮按钮
    floatBtn = document.createElement('button');
    floatBtn.textContent = '▶ 直播播放';
    floatBtn.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 999998;
      padding: 10px 18px; background: #e94560; color: #fff; border: none;
      border-radius: 20px; font-size: 13px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 16px rgba(233,69,96,.4); font-family: -apple-system, sans-serif;
      transition: all .2s;
    `;
    floatBtn.onclick = () => {
      createPanel();
      if (capturedLive) {
        doPlay(capturedLive, capturedName);
      } else {
        setStatus('⏳ 正在等待直播地址，请刷新页面或稍后再试');
      }
    };
    document.body.appendChild(floatBtn);
    updateButtonState();
  }

  /* ========== 播放主流程 ========== */
  async function doPlay(input, name) {
    createPanel();
    setStatus('正在处理地址...');

    let url;
    if (/^https?:\/\//i.test(input)) {
      // 明文地址直接播放
      url = input;
      setStatus('✅ 检测到直接播放地址，加载中...');
    } else {
      setStatus('🔐 正在解密 live_address...');
      try {
        url = decryptLiveAddress(input);
      } catch (e) {
        setStatus('❌ 解密失败：' + e.message);
        return;
      }
      if (!url || !url.startsWith('http')) {
        setStatus('❌ 解密结果异常');
        return;
      }
      setStatus('✅ 解密成功，加载播放器...');
    }

    const video = panel.querySelector('#kklive-video');
    try {
      const Hls = await loadHls();
      video.style.display = 'block';
      if (Hls.isSupported()) {
        if (video._hls) video._hls.destroy();
        const hls = new Hls({ liveDurationInfinity: true });
        video._hls = hls;
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
          setStatus('🎉 正在播放：' + (name || '直播'));
        });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            setStatus('⚠️ 播放错误：' + data.type + ' / ' + data.details);
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.play().catch(() => {});
        setStatus('🎉 正在播放（原生HLS）：' + (name || '直播'));
      } else {
        setStatus('❌ 当前浏览器不支持 HLS');
      }
    } catch (e) {
      setStatus('❌ 播放器加载失败：' + e.message);
    }
  }

  /* ========== 页面加载完成后初始化按钮 ========== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
