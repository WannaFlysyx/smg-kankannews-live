// ==UserScript==
// @name         看看新闻直播一键播放版
// @namespace    http://tampermonkey.net/
// @author       https://github.com/WannaFlysyx
// @version      3.0
// @description  收看看看新闻直播，支持回看当天已播节目和进度条拖动
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

  /* ========== RSA 解密（保持不变） ========== */
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

  /* ========== 注入页面脚本（保持不变） ========== */
  function injectInterceptor() {
    const code = `
      (function() {
        function isUrlMatch(url, keyword) {
          try { return new URL(url, location.href).pathname.includes(keyword); }
          catch(e) { return String(url).includes(keyword); }
        }

        function processResponse(url, text) {
          if (typeof text !== 'string') return;
          try {
            const j = JSON.parse(text);
            if (!j || j.code !== '1000' || !j.result) return;

            if (isUrlMatch(url, '/channel/detail')) {
              const liveAddress = j.result.live_address;
              if (liveAddress && typeof liveAddress === 'string' && liveAddress.length > 0) {
                window.postMessage({
                  source: 'kklive-interceptor',
                  type: 'channel_info',
                  channel_id: j.result.id,
                  channel_name: j.result.name,
                  live_address: liveAddress
                }, '*');
              }
            }

            if (isUrlMatch(url, '/programs')) {
              const programs = j.result.programs;
              if (Array.isArray(programs) && programs.length > 0) {
                window.postMessage({
                  source: 'kklive-interceptor',
                  type: 'program_list',
                  channel_id: j.result.id,
                  channel_name: j.result.name,
                  date: j.result.date || '',
                  programs: programs
                }, '*');
              }
            }
          } catch(e) {}
        }

        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
          this._kklive_url = url;
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
          if (this._kklive_url) {
            this.addEventListener('load', function() {
              processResponse(this._kklive_url, this.responseText);
            });
          }
          return origSend.apply(this, arguments);
        };

        const origFetch = window.fetch;
        window.fetch = function(url, opts) {
          return origFetch.apply(this, arguments).then(function(resp) {
            const u = (typeof url === 'string') ? url : (url && url.url);
            if (u) {
              resp.clone().text().then(raw => processResponse(u, raw));
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

  /* ========== 内容脚本状态（保持不变） ========== */
  let capturedLive = null;
  let decryptedLiveUrl = null;
  let capturedName = '';
  let currentChannelId = null;
  let programList = [];
  let currentDate = '';

  function getTodayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data || data.source !== 'kklive-interceptor') return;

    if (data.type === 'channel_info') {
      capturedLive = data.live_address;
      capturedName = data.channel_name || '直播';
      currentChannelId = data.channel_id;
      try {
        decryptedLiveUrl = decryptLiveAddress(capturedLive);
        console.log('[KKLive] 直播地址解密成功:', decryptedLiveUrl);
      } catch (err) {
        console.error('[KKLive] 直播地址解密失败:', err);
        decryptedLiveUrl = null;
      }
      updateButtonState();
      updateChannelNameUI();
    }

    if (data.type === 'program_list') {
      programList = data.programs || [];
      currentDate = data.date || getTodayStr();
      if (data.channel_name) capturedName = data.channel_name;
      console.log('[KKLive] 捕获到节目列表，共', programList.length, '个节目，日期：', currentDate);
      updateProgramListUI();
      updateDateUI();
    }
  });

  /* ========== 加载 hls.js（保持不变） ========== */
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

  /* ========== 🎨 美化的 UI 面板 ========== */
  let panel = null;
  let floatBtn = null;

  function createPanel() {
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'kklive-panel';
    panel.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 999999;
      width: 400px;
      max-height: 86vh;
      background: rgba(20, 22, 36, 0.88);
      backdrop-filter: blur(16px) saturate(180%);
      -webkit-backdrop-filter: blur(16px) saturate(180%);
      color: #f0f0f5;
      border-radius: 20px;
      box-shadow: 0 24px 48px -12px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.06);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: transform 0.25s ease, opacity 0.25s ease;
    `;

    // 头部
    const header = document.createElement('div');
    header.style.cssText = `
      padding: 14px 20px;
      background: linear-gradient(145deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01));
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    `;
    header.innerHTML = `
      <span style="font-weight: 600; font-size: 15px; letter-spacing: 0.3px; display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 18px;">📺</span> 看看播放器
      </span>
      <span id="kklive-close" style="cursor: pointer; opacity: 0.5; font-size: 20px; line-height: 1; transition: opacity 0.2s; padding: 0 4px;">✕</span>
    `;
    panel.appendChild(header);

    // 频道信息行
    const channelRow = document.createElement('div');
    channelRow.style.cssText = `
      padding: 8px 20px 6px 20px;
      background: rgba(255,255,255,0.02);
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    `;
    channelRow.innerHTML = `
      <span style="opacity:0.5;">📡</span>
      <span id="kklive-channel-name" style="font-weight: 500;"></span>
    `;
    panel.appendChild(channelRow);

    // 直播按钮
    const liveBtnWrap = document.createElement('div');
    liveBtnWrap.style.cssText = `padding: 10px 20px; border-bottom: 1px solid rgba(255,255,255,0.04);`;
    const liveBtn = document.createElement('button');
    liveBtn.id = 'kklive-live-btn';
    liveBtn.textContent = '▶ 播放直播';
    liveBtn.style.cssText = `
      width: 100%;
      padding: 10px 0;
      background: linear-gradient(135deg, #34d399, #22d3ee);
      color: #0c0e1a;
      border: none;
      border-radius: 40px;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: 0 4px 14px rgba(52, 211, 153, 0.3);
      letter-spacing: 0.3px;
    `;
    liveBtn.onmouseenter = () => { liveBtn.style.transform = 'scale(1.02)'; liveBtn.style.boxShadow = '0 6px 20px rgba(52, 211, 153, 0.4)'; };
    liveBtn.onmouseleave = () => { liveBtn.style.transform = 'scale(1)'; liveBtn.style.boxShadow = '0 4px 14px rgba(52, 211, 153, 0.3)'; };
    liveBtnWrap.appendChild(liveBtn);
    panel.appendChild(liveBtnWrap);

    // 节目单头部（日期 + 刷新）
    const progHeader = document.createElement('div');
    progHeader.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 20px 4px 20px;
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid rgba(255,255,255,0.04);
    `;
    progHeader.innerHTML = `
      <span id="kklive-date" style="font-size: 12px; opacity: 0.6; letter-spacing: 0.2px;"></span>
      <button id="kklive-refresh-btn" style="
        background: rgba(255,255,255,0.06);
        color: #d0d0e0;
        border: none;
        border-radius: 16px;
        padding: 4px 14px;
        font-size: 11px;
        cursor: pointer;
        transition: background 0.2s;
      ">🔄 刷新</button>
    `;
    panel.appendChild(progHeader);

    // 节目列表容器（可滚动）
    const listWrap = document.createElement('div');
    listWrap.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: 6px 12px 10px 12px;
      background: rgba(0,0,0,0.15);
      max-height: 360px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.15) transparent;
    `;
    // 自定义滚动条（webkit）
    const styleScroll = document.createElement('style');
    styleScroll.textContent = `
      #kklive-panel ::-webkit-scrollbar { width: 4px; }
      #kklive-panel ::-webkit-scrollbar-track { background: transparent; }
      #kklive-panel ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
      #kklive-panel ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.35); }
    `;
    panel.appendChild(styleScroll);

    const listEl = document.createElement('div');
    listEl.id = 'kklive-program-list';
    listEl.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
    listWrap.appendChild(listEl);
    panel.appendChild(listWrap);

    // 视频播放器
    const video = document.createElement('video');
    video.id = 'kklive-video';
    video.style.cssText = `
      width: 100%;
      display: none;
      background: #000;
      max-height: 200px;
      border-top: 1px solid rgba(255,255,255,0.06);
    `;
    video.controls = true;
    video.playsInline = true;
    panel.appendChild(video);

    // 状态栏
    const status = document.createElement('div');
    status.id = 'kklive-status';
    status.style.cssText = `
      padding: 10px 20px;
      font-size: 12px;
      opacity: 0.8;
      min-height: 22px;
      background: rgba(0,0,0,0.2);
      border-top: 1px solid rgba(255,255,255,0.04);
      color: #c0c0d0;
      letter-spacing: 0.2px;
    `;
    panel.appendChild(status);

    document.body.appendChild(panel);

    // 事件绑定
    panel.querySelector('#kklive-close').onclick = () => {
      const videoEl = panel.querySelector('#kklive-video');
      if (videoEl._hls) videoEl._hls.destroy();
      panel.remove();
      panel = null;
    };

    panel.querySelector('#kklive-live-btn').onclick = () => playLive();

    panel.querySelector('#kklive-refresh-btn').onclick = () => {
      setStatus('💡 节目单由页面自动加载，可尝试刷新页面');
      if (programList.length === 0) {
        setStatus('⚠️ 未捕获到节目列表，请刷新页面后重试');
      } else {
        updateProgramListUI();
        setStatus('✅ 节目单已更新');
      }
    };

    updateChannelNameUI();
    updateDateUI();
    updateProgramListUI();
    return panel;
  }

  /* ========== UI 更新辅助函数 ========== */
  function updateChannelNameUI() {
    if (!panel) return;
    const nameEl = panel.querySelector('#kklive-channel-name');
    if (nameEl) nameEl.textContent = capturedName || '未知频道';
  }

  function updateDateUI() {
    if (!panel) return;
    const dateEl = panel.querySelector('#kklive-date');
    if (dateEl) dateEl.textContent = currentDate ? '📅 ' + currentDate : getTodayStr();
  }

  function setStatus(msg) {
    if (!panel) return;
    const statusEl = panel.querySelector('#kklive-status');
    if (statusEl) statusEl.textContent = msg;
  }

  function updateButtonState() {
    if (!floatBtn) return;
    if (decryptedLiveUrl || capturedLive) {
      floatBtn.textContent = '▶ 直播就绪';
      floatBtn.style.background = 'linear-gradient(135deg, #34d399, #22d3ee)';
      floatBtn.style.color = '#0c0e1a';
      floatBtn.style.boxShadow = '0 6px 24px rgba(52, 211, 153, 0.4)';
    } else {
      floatBtn.textContent = '⏳ 加载中...';
      floatBtn.style.background = 'rgba(255,255,255,0.08)';
      floatBtn.style.color = '#aaa';
      floatBtn.style.boxShadow = 'none';
    }
  }

  function updateProgramListUI() {
    if (!panel) return;
    const listEl = panel.querySelector('#kklive-program-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (programList.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = `
        padding: 24px 12px;
        text-align: center;
        opacity: 0.4;
        font-size: 13px;
        letter-spacing: 0.3px;
      `;
      empty.textContent = '📭 暂无节目数据，请等待页面加载';
      listEl.appendChild(empty);
      return;
    }

    programList.forEach(prog => {
      const btn = document.createElement('button');
      const start = prog.start_time_string ? prog.start_time_string.slice(11, 16) : '';
      const end = prog.end_time_string ? prog.end_time_string.slice(11, 16) : '';
      btn.textContent = `${prog.name}  ${start} - ${end}`;
      btn.style.cssText = `
        width: 100%;
        padding: 8px 12px;
        background: rgba(255,255,255,0.04);
        color: #e8e8f0;
        border: none;
        border-radius: 12px;
        cursor: pointer;
        text-align: left;
        font-size: 12.5px;
        transition: all 0.15s ease;
        font-weight: 450;
        letter-spacing: 0.1px;
      `;
      btn.onmouseenter = () => { btn.style.background = 'rgba(255,255,255,0.10)'; btn.style.transform = 'translateX(2px)'; };
      btn.onmouseleave = () => { btn.style.background = 'rgba(255,255,255,0.04)'; btn.style.transform = 'translateX(0)'; };
      btn.onclick = () => playReplay(prog);
      listEl.appendChild(btn);
    });
  }

  /* ========== 浮动按钮（美化） ========== */
  function initFloatBtn() {
    if (floatBtn) return;
    floatBtn = document.createElement('button');
    floatBtn.textContent = '▶ 直播';
    floatBtn.style.cssText = `
      position: fixed;
      bottom: 28px;
      right: 28px;
      z-index: 999998;
      padding: 12px 24px;
      background: linear-gradient(135deg, #34d399, #22d3ee);
      color: #0c0e1a;
      border: none;
      border-radius: 40px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 8px 28px rgba(52, 211, 153, 0.35);
      transition: all 0.25s ease;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      letter-spacing: 0.3px;
      backdrop-filter: blur(4px);
      border: 1px solid rgba(255,255,255,0.08);
    `;
    floatBtn.onmouseenter = () => {
      floatBtn.style.transform = 'scale(1.06)';
      floatBtn.style.boxShadow = '0 12px 36px rgba(52, 211, 153, 0.5)';
    };
    floatBtn.onmouseleave = () => {
      floatBtn.style.transform = 'scale(1)';
      floatBtn.style.boxShadow = '0 8px 28px rgba(52, 211, 153, 0.35)';
    };
    floatBtn.onclick = () => {
      createPanel();
      if (decryptedLiveUrl) {
        playLive();
      } else {
        setStatus('⏳ 等待直播地址，请刷新页面或稍后重试');
      }
    };
    document.body.appendChild(floatBtn);
    updateButtonState();
  }

  /* ========== 播放功能（保持不变） ========== */
  function playLive() {
    createPanel();
    if (!decryptedLiveUrl) {
      setStatus('❌ 直播地址未就绪，请刷新页面重试');
      return;
    }
    doPlay(decryptedLiveUrl, capturedName || '直播');
  }

  function playReplay(program) {
    createPanel();
    if (!decryptedLiveUrl) {
      setStatus('❌ 未获取到频道直播地址，无法回放');
      return;
    }
    let url = decryptedLiveUrl;
    if (/\.m3u8/.test(url) && program.start_time && program.end_time) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}start=${program.start_time}&end=${program.end_time}`;
    }
    const title = program.name || '回放';
    setStatus('⏳ 加载回放：' + title);
    doPlay(url, title);
  }

  async function doPlay(input, name) {
    createPanel();
    setStatus('正在处理地址...');

    let url = input;
    if (!/^https?:\/\//i.test(url)) {
      setStatus('🔐 解密中...');
      try {
        url = decryptLiveAddress(url);
      } catch (e) {
        setStatus('❌ 解密失败：' + e.message);
        return;
      }
      if (!url || !url.startsWith('http')) {
        setStatus('❌ 解密结果异常');
        return;
      }
      setStatus('✅ 解密成功，加载播放器...');
    } else {
      setStatus('✅ 加载播放器...');
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

  /* ========== 初始化 ========== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFloatBtn);
  } else {
    initFloatBtn();
  }
})();
