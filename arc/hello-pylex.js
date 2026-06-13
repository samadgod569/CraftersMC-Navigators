(function () {
  if (window.__helloPylexLoaded) return;
  window.__helloPylexLoaded = true;

  const appName = new URLSearchParams(location.search).get('app') || 'unknown';

  console.log('[HelloPylex] extension loaded for app:', appName);

  const badge = document.createElement('div');
  badge.id = 'hello-pylex-badge';
  badge.innerHTML = `
    <span style="font-size:18px;">🧩</span>
    <span style="font-size:0.78rem;font-weight:600;">Hello Pylex</span>
    <span style="font-size:0.72rem;opacity:0.7;">${appName}</span>
    <button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;color:inherit;font-size:14px;margin-left:4px;opacity:0.6;">✕</button>
  `;
  Object.assign(badge.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '99999',
    background: '#f38020',
    color: '#fff',
    padding: '10px 14px',
    borderRadius: '10px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    boxShadow: '0 4px 20px rgba(243,128,32,0.4)',
    fontFamily: 'IBM Plex Sans, sans-serif',
    animation: 'helloPylexSlide 0.4s cubic-bezier(0.2,0.9,0.4,1)',
  });

  const style = document.createElement('style');
  style.textContent = `
    @keyframes helloPylexSlide {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(badge);
})();
