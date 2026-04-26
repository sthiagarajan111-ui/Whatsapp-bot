/* Shared utilities for all dashboard pages */

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString('en-AE', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function scoreBadge(score) {
  score = parseInt(score) || 0;
  if (score >= 8) return `<span class="badge badge-red">🔥 HOT ${score}</span>`;
  if (score >= 5) return `<span class="badge badge-amber">🌡 WARM ${score}</span>`;
  return `<span class="badge badge-gray">❄ COLD ${score}</span>`;
}

function statusBadge(status) {
  const map = {
    new:       ['badge-blue',   'New'],
    contacted: ['badge-cyan',   'Contacted'],
    converted: ['badge-green',  'Converted'],
    lost:      ['badge-gray',   'Lost'],
  };
  const [cls, label] = map[status] || ['badge-gray', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function avatarInitials(name, colorClass) {
  const initials = (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const colors = ['avatar-blue', 'avatar-green', 'avatar-purple', 'avatar-amber', 'avatar-red'];
  const cls = colorClass || colors[initials.charCodeAt(0) % colors.length];
  return `<div class="avatar ${cls}">${initials}</div>`;
}

async function apiFetch(url, options = {}) {
  options.headers = options.headers || {};
  options.headers['x-client-id'] = window.__clientId || 'default';
  options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function showToast(msg, type = 'success') {
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:8px;font-size:13px;font-weight:500;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.15);`;
  t.style.background = type === 'success' ? '#10B981' : '#EF4444';
  t.style.color = '#fff';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// Fix 6: refresh sidebar badge counts from the unified stats API
async function refreshSidebarBadges() {
  try {
    const res = await fetch('/api/stats', {
      headers: { 'x-client-id': window.__clientId || 'default' }
    });
    const data = await res.json();
    const convBadge = document.querySelector('[data-badge="conversations"]');
    const apptBadge = document.querySelector('[data-badge="appointments"]');
    if (convBadge) convBadge.textContent = data.totalLeads ?? 0;
    if (apptBadge) apptBadge.textContent = data.todayAppointments ?? 0;
  } catch(_) {}
}

window.shared = { timeAgo, formatDate, scoreBadge, statusBadge, avatarInitials, apiFetch, showToast, refreshSidebarBadges };
