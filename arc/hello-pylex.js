(function () {
  if (window.__helloPylexLoaded) return;
  window.__helloPylexLoaded = true;

  const appName = new URLSearchParams(location.search).get('app') || 'unknown';

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    #pylex-ext-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 99999;
      background: linear-gradient(90deg, #f38020, #e06010);
      color: #fff;
      padding: 0 20px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-family: 'IBM Plex Sans', sans-serif;
      font-size: 0.82rem;
      box-shadow: 0 -4px 20px rgba(243,128,32,0.35);
      animation: extBarSlide 0.4s cubic-bezier(0.2,0.9,0.4,1);
    }
    @keyframes extBarSlide {
      from { transform: translateY(100%); opacity: 0; }
      to   { transform: translateY(0);   opacity: 1; }
    }
    #pylex-ext-bar .ext-bar-left {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
    }
    #pylex-ext-bar .ext-bar-pill {
      background: rgba(255,255,255,0.2);
      border-radius: 20px;
      padding: 2px 10px;
      font-size: 0.72rem;
      font-family: monospace;
    }
    #pylex-ext-bar .ext-bar-right {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 0.75rem;
      opacity: 0.85;
    }
    #pylex-ext-bar-close {
      background: rgba(255,255,255,0.15);
      border: none;
      color: #fff;
      border-radius: 6px;
      padding: 3px 10px;
      cursor: pointer;
      font-size: 0.75rem;
      transition: background 0.15s;
    }
    #pylex-ext-bar-close:hover { background: rgba(255,255,255,0.3); }

    #pylex-ext-toast {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 99999;
      background: #1a1d27;
      border: 1px solid #f38020;
      border-radius: 10px;
      padding: 14px 18px;
      color: #fff;
      font-family: 'IBM Plex Sans', sans-serif;
      font-size: 0.82rem;
      max-width: 280px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.4);
      animation: extToastIn 0.35s cubic-bezier(0.2,0.9,0.4,1);
    }
    @keyframes extToastIn {
      from { transform: translateX(40px); opacity: 0; }
      to   { transform: translateX(0);    opacity: 1; }
    }
    #pylex-ext-toast .toast-title {
      font-weight: 700;
      color: #f38020;
      margin-bottom: 5px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #pylex-ext-toast .toast-body {
      color: #aaa;
      font-size: 0.76rem;
      line-height: 1.5;
    }
  `;
  document.head.appendChild(style);

  // Toast notification (top-right, auto dismisses)
  const toast = document.createElement('div');
  toast.id = 'pylex-ext-toast';
  toast.innerHTML = `
    <div class="toast-title">🧩 Hello Pylex Extension</div>
    <div class="toast-body">Extension loaded for <strong style="color:#fff">${appName}</strong>.<br/>Extension system is working correctly.</div>
  `;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity 0.4s, transform 0.4s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(40px)';
    setTimeout(() => toast.remove(), 400);
  }, 4000);

  // Persistent bottom bar
  const bar = document.createElement('div');
  bar.id = 'pylex-ext-bar';
  bar.innerHTML = `
    <div class="ext-bar-left">
      🧩 Hello Pylex
      <span class="ext-bar-pill">${appName}</span>
      <span class="ext-bar-pill">v1.0.0</span>
    </div>
    <div class="ext-bar-right">
      <span id="pylex-ext-time"></span>
      <button id="pylex-ext-bar-close">Dismiss</button>
    </div>
  `;
  document.body.appendChild(bar);

  // Live clock in the bar
  function updateTime() {
    const el = document.getElementById('pylex-ext-time');
    if (el) el.textContent = new Date().toLocaleTimeString();
  }
  updateTime();
  setInterval(updateTime, 1000);

  document.getElementById('pylex-ext-bar-close').addEventListener('click', () => {
    bar.style.transition = 'transform 0.3s, opacity 0.3s';
    bar.style.transform = 'translateY(100%)';
    bar.style.opacity = '0';
    setTimeout(() => bar.remove(), 300);
  });

  console.log('[HelloPylex] ✅ Extension loaded for app:', appName);
})();
