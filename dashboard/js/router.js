/* Hash-based client-side router for dashboard */
(function () {
  function getHash() {
    return (location.hash || '#dashboard').slice(1);
  }

  async function navigate(page) {
    // Update sidebar active state
    document.querySelectorAll('.nav-link').forEach(a => {
      a.classList.toggle('active', a.dataset.page === page);
    });

    const mainDash = document.getElementById('main-dashboard');
    const container = document.getElementById('page-content');

    if (page === 'dashboard') {
      if (mainDash) mainDash.style.display = '';
      if (container) container.style.display = 'none';
      if (window.loadAll) window.loadAll(); // refresh main dashboard
      return;
    }

    // Hide main dashboard, show page-content
    if (mainDash) mainDash.style.display = 'none';
    if (container) container.style.display = '';

    const base = window.__clientId
      ? `/client-dashboard/${window.__clientId}/pages`
      : '/dashboard/pages';
    const PAGE_URLS = {
      conversations:  `${base}/conversations.html`,
      opportunities:  `${base}/opportunities.html`,
      analytics:      `${base}/analytics.html`,
      appointments:   `${base}/appointments.html`,
      settings:       `${base}/settings.html`,
      recordings:     `${base}/recordings.html`,
      'lead-profile': `${base}/lead-profile.html`,
      campaigns:      `${base}/campaigns.html`,
    };

    const url = PAGE_URLS[page];
    if (!url || !container) return;

    container.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:40px;color:var(--text3)"><div style="width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0"></div>Loading...</div>';
    try {
      const res = await fetch(url);
      const html = await res.text();
      container.innerHTML = html;
      // Execute embedded scripts
      container.querySelectorAll('script').forEach(old => {
        const s = document.createElement('script');
        if (old.src) { s.src = old.src; }
        else { s.textContent = old.textContent; }
        document.body.appendChild(s).parentNode.removeChild(s);
      });
    } catch (err) {
      container.innerHTML = `<div style="padding:40px;color:var(--red)">⚠️ Failed to load page: ${err.message}</div>`;
    }
  }

  function init() {
    window.navigateTo = navigate;
    window.addEventListener('hashchange', () => navigate(getHash()));
    navigate(getHash());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
