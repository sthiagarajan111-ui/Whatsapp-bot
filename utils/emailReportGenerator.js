/**
 * Daily email report generator for agents.
 * Produces a fully inline-styled HTML email compatible with Gmail, Outlook, Apple Mail.
 */

function generateDailyEmailReport(agentEmail, agentName, leads, stats, todayAppointments = []) {
  const now       = new Date();
  const clientName = process.env.CLIENT_NAME || 'LeadPulse';
  const renderUrl  = process.env.RENDER_EXTERNAL_URL || 'https://whatsapp-bot-41x7.onrender.com';

  // Date strings
  const dateStr = now.toLocaleDateString('en-AE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  // Yesterday window
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  // Categorise leads
  const hotLeads  = leads.filter(l => (l.score || 0) >= 8);
  const warmLeads = leads.filter(l => (l.score || 0) >= 5 && (l.score || 0) < 8);
  const coldLeads = leads.filter(l => (l.score || 0) > 0 && (l.score || 0) < 5);
  const newYesterday = leads.filter(l => {
    const d = new Date(l.created_at);
    return d >= yesterday;
  });

  // Pipeline counts
  const pipelineNew       = leads.filter(l => l.status === 'new').length;
  const pipelineContacted = leads.filter(l => l.status === 'contacted').length;
  const pipelineConverted = leads.filter(l => l.status === 'converted').length;
  const pipelineLost      = leads.filter(l => l.status === 'lost').length;
  const pipelineTotal     = leads.length;
  const convRate = pipelineTotal ? Math.round(pipelineConverted / pipelineTotal * 100) : 0;

  // Pipeline value (budget strings to AED M estimate)
  function budgetToM(b) {
    if (!b) return 0;
    const map = { '500k': 0.5, '1m': 1, '2m': 2, '3m': 3, '5m': 5, '10m': 10 };
    const key = String(b).toLowerCase().replace(/[^0-9km]/g, '');
    return map[key] || 0;
  }
  const pipelineValue = leads.reduce((s, l) => {
    const d = l.data || {};
    return s + budgetToM(d.budget);
  }, 0);
  const pipelineValueStr = pipelineValue >= 1
    ? pipelineValue.toFixed(1) + 'M'
    : pipelineValue > 0 ? (pipelineValue * 1000).toFixed(0) + 'K' : '—';

  // Top hot lead
  const topHot = hotLeads.sort((a, b) => (b.score || 0) - (a.score || 0))[0];

  // Leads older than 3 days
  const threeDaysAgo = new Date(now);
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const staleLeads = leads.filter(l => new Date(l.created_at) < threeDaysAgo && l.status === 'new');

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function daysSince(dateStr) {
    return Math.floor((now - new Date(dateStr)) / 86400000);
  }

  function getArea(l)     { return (l.data || {}).area     || '—'; }
  function getBudget(l)   { return (l.data || {}).budget   || '—'; }
  function getInterest(l) { return (l.data || {}).interest || (l.data || {}).intent || '—'; }
  function getLang(l)     { return (l.data || {}).language || l.language || 'en'; }
  function getSource(l)   { return (l.data || {}).source   || '—'; }

  function tableRow(l, bg) {
    const d = l.data || {};
    return `
      <tr style="background:${bg}">
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:13px">${l.name || '—'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;color:#6B7280">${l.wa_number || '—'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px">${getInterest(l)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px">${getBudget(l)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px">${getArea(l)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:center;font-weight:700">${l.score || 0}/10</td>
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:center">${daysSince(l.created_at)}d</td>
      </tr>`;
  }

  function newLeadRow(l) {
    return `
      <tr style="background:#FFFFFF">
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:13px">${l.name || '—'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;color:#6B7280">${l.wa_number || '—'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px">${getSource(l)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px">${getInterest(l)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px">${getBudget(l)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px">${getArea(l)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:center;font-weight:700">${l.score || 0}/10</td>
        <td style="padding:8px 10px;border-bottom:1px solid #F3F4F6;font-size:12px;text-align:center">${getLang(l).toUpperCase()}</td>
      </tr>`;
  }

  function tableHeaders(cols) {
    return cols.map(c => `<th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:.5px;background:#F9FAFB">${c}</th>`).join('');
  }

  // ── Pipeline bar helper ───────────────────────────────────────────────────────
  const maxBar = Math.max(pipelineNew, pipelineContacted, pipelineConverted, pipelineLost, 1);
  function bar(count, color) {
    const pct = Math.round(count / maxBar * 100);
    return `<div style="display:inline-block;height:20px;width:${pct}%;min-width:${count>0?'4px':'0'};background:${color};border-radius:3px;vertical-align:middle"></div>`;
  }

  // ── Action items ──────────────────────────────────────────────────────────────
  const actionItems = [];
  actionItems.push(`You have <strong>${hotLeads.length}</strong> HOT lead${hotLeads.length !== 1 ? 's' : ''} requiring immediate follow-up`);
  if (topHot) {
    actionItems.push(`Priority contact: <strong>${topHot.name || 'Unknown'}</strong> — ${getInterest(topHot)} in ${getArea(topHot)}, score ${topHot.score}/10`);
  }
  if (staleLeads.length > 0) {
    actionItems.push(`<strong>${staleLeads.length}</strong> lead${staleLeads.length !== 1 ? 's have' : ' has'} been waiting 3+ days — consider re-engagement`);
  }
  actionItems.push(`Total pipeline value: AED ${pipelineValueStr} across <strong>${pipelineTotal}</strong> active leads`);

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">

      <!-- HEADER -->
      <tr><td style="background:#1C2333;padding:28px 32px">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td>
              <div style="font-size:26px;font-weight:800;color:#FFFFFF;letter-spacing:-0.5px">LeadPulse</div>
              <div style="font-size:14px;color:#A8B5CC;margin-top:2px">${clientName}</div>
            </td>
            <td align="right" style="vertical-align:top">
              <div style="font-size:13px;color:#6B7A99">${dateStr}</div>
            </td>
          </tr>
          <tr><td colspan="2" style="padding-top:16px">
            <div style="font-size:20px;font-weight:600;color:#FFFFFF">Good morning, ${agentName} 👋</div>
            <div style="font-size:13px;color:#A8B5CC;margin-top:4px">Here's your daily lead report. Let's close some deals today.</div>
          </td></tr>
        </table>
      </td></tr>

      <!-- STAT BOXES -->
      <tr><td style="padding:24px 32px 0">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="25%" style="padding:0 6px 0 0">
              <div style="background:#3D7FFA;border-radius:8px;padding:16px;text-align:center">
                <div style="font-size:28px;font-weight:800;color:#FFFFFF">${newYesterday.length}</div>
                <div style="font-size:11px;color:rgba(255,255,255,.85);margin-top:2px;font-weight:500">New Yesterday</div>
              </div>
            </td>
            <td width="25%" style="padding:0 6px">
              <div style="background:#EF4444;border-radius:8px;padding:16px;text-align:center">
                <div style="font-size:28px;font-weight:800;color:#FFFFFF">${hotLeads.length}</div>
                <div style="font-size:11px;color:rgba(255,255,255,.85);margin-top:2px;font-weight:500">HOT Leads</div>
              </div>
            </td>
            <td width="25%" style="padding:0 6px">
              <div style="background:#10B981;border-radius:8px;padding:16px;text-align:center">
                <div style="font-size:28px;font-weight:800;color:#FFFFFF">${pipelineConverted}</div>
                <div style="font-size:11px;color:rgba(255,255,255,.85);margin-top:2px;font-weight:500">Converted</div>
              </div>
            </td>
            <td width="25%" style="padding:0 0 0 6px">
              <div style="background:#F59E0B;border-radius:8px;padding:16px;text-align:center">
                <div style="font-size:28px;font-weight:800;color:#FFFFFF">AED ${pipelineValueStr}</div>
                <div style="font-size:11px;color:rgba(255,255,255,.85);margin-top:2px;font-weight:500">Pipeline Value</div>
              </div>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- HOT LEADS TABLE -->
      <tr><td style="padding:24px 32px 0">
        <div style="background:#EF4444;padding:12px 16px;border-radius:8px 8px 0 0">
          <span style="font-size:14px;font-weight:700;color:#FFFFFF">🔥 HOT LEADS — Action Required Today</span>
        </div>
        ${hotLeads.length === 0
          ? `<div style="background:#FEF2F2;padding:16px;border-radius:0 0 8px 8px;font-size:13px;color:#9CA3AF;text-align:center">No HOT leads currently — keep qualifying!</div>`
          : `<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:0 0 8px 8px;overflow:hidden">
              <thead><tr>${tableHeaders(['Name','Number','Interest','Budget','Area','Score','Waiting'])}</tr></thead>
              <tbody>${hotLeads.map(l => tableRow(l, '#FEF2F2')).join('')}</tbody>
             </table>`
        }
      </td></tr>

      <!-- WARM LEADS TABLE -->
      <tr><td style="padding:24px 32px 0">
        <div style="background:#F59E0B;padding:12px 16px;border-radius:8px 8px 0 0">
          <span style="font-size:14px;font-weight:700;color:#FFFFFF">◐ WARM LEADS — Follow Up This Week</span>
        </div>
        ${warmLeads.length === 0
          ? `<div style="background:#FFFBEB;padding:16px;border-radius:0 0 8px 8px;font-size:13px;color:#9CA3AF;text-align:center">No WARM leads currently</div>`
          : `<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:0 0 8px 8px;overflow:hidden">
              <thead><tr>${tableHeaders(['Name','Number','Interest','Budget','Area','Score','Waiting'])}</tr></thead>
              <tbody>${warmLeads.map(l => tableRow(l, '#FFFBEB')).join('')}</tbody>
             </table>`
        }
      </td></tr>

      <!-- COLD LEADS TABLE -->
      <tr><td style="padding:24px 32px 0">
        <div style="background:#3D7FFA;padding:12px 16px;border-radius:8px 8px 0 0">
          <span style="font-size:14px;font-weight:700;color:#FFFFFF">❄ COLD LEADS — In Pipeline</span>
        </div>
        ${coldLeads.length === 0
          ? `<div style="background:#EFF6FF;padding:16px;border-radius:0 0 8px 8px;font-size:13px;color:#9CA3AF;text-align:center">No COLD leads currently</div>`
          : `<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:0 0 8px 8px;overflow:hidden">
              <thead><tr>${tableHeaders(['Name','Number','Interest','Budget','Area','Score','Waiting'])}</tr></thead>
              <tbody>${coldLeads.map(l => tableRow(l, '#EFF6FF')).join('')}</tbody>
             </table>`
        }
      </td></tr>

      <!-- YESTERDAY'S NEW LEADS -->
      <tr><td style="padding:24px 32px 0">
        <div style="background:#6B7280;padding:12px 16px;border-radius:8px 8px 0 0">
          <span style="font-size:14px;font-weight:700;color:#FFFFFF">📥 New Leads — Last 24 Hours</span>
        </div>
        ${newYesterday.length === 0
          ? `<div style="background:#F9FAFB;padding:16px;border-radius:0 0 8px 8px;font-size:13px;color:#9CA3AF;text-align:center">No new leads in the last 24 hours</div>`
          : `<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:0 0 8px 8px;overflow:hidden">
              <thead><tr>${tableHeaders(['Name','Number','Source','Interest','Budget','Area','Score','Lang'])}</tr></thead>
              <tbody>${newYesterday.map(l => newLeadRow(l)).join('')}</tbody>
             </table>`
        }
      </td></tr>

      <!-- TODAY'S APPOINTMENTS -->
      <tr><td style="padding:24px 32px 0">
        <div style="background:#7C3AED;padding:12px 16px;border-radius:8px 8px 0 0">
          <span style="font-size:14px;font-weight:700;color:#FFFFFF">📅 Today's Appointments</span>
        </div>
        ${todayAppointments.length === 0
          ? `<div style="background:#F5F3FF;padding:16px;border-radius:0 0 8px 8px;font-size:13px;color:#9CA3AF;text-align:center">No appointments scheduled for today</div>`
          : `<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:0 0 8px 8px;overflow:hidden">
              <thead><tr>${tableHeaders(['Client', 'Time Slot', 'Interest', 'Score', 'Status'])}</tr></thead>
              <tbody>${todayAppointments.map(a => `
                <tr style="background:#F5F3FF">
                  <td style="padding:8px 10px;border-bottom:1px solid #EDE9FE;font-size:13px;font-weight:600">${a.lead_name || '—'}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #EDE9FE;font-size:12px;color:#7C3AED">${a.time_slot || '—'}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #EDE9FE;font-size:12px">${a.industry || '—'}</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #EDE9FE;font-size:12px;text-align:center;font-weight:700">${a.lead_score || 0}/10</td>
                  <td style="padding:8px 10px;border-bottom:1px solid #EDE9FE;font-size:12px;text-align:center">${a.status || 'confirmed'}</td>
                </tr>`).join('')}
              </tbody>
             </table>`
        }
      </td></tr>

      <!-- ACTION ITEMS -->
      <tr><td style="padding:24px 32px 0">
        <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:16px">
          <div style="font-size:14px;font-weight:700;color:#1F2937;margin-bottom:12px">📋 Today's Action Items</div>
          ${actionItems.map(item => `
            <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:8px">
              <div style="width:6px;height:6px;background:#3D7FFA;border-radius:50%;margin-top:6px;flex-shrink:0"></div>
              <div style="font-size:13px;color:#374151;line-height:1.5">${item}</div>
            </div>`).join('')}
        </div>
      </td></tr>

      <!-- PIPELINE FUNNEL -->
      <tr><td style="padding:24px 32px 0">
        <div style="font-size:15px;font-weight:700;color:#1F2937;margin-bottom:14px">Pipeline Summary</div>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="80" style="font-size:12px;color:#6B7280;padding:5px 0">New</td>
            <td style="padding:5px 8px">${bar(pipelineNew, '#3D7FFA')}</td>
            <td width="40" style="font-size:12px;font-weight:700;color:#3D7FFA;text-align:right">${pipelineNew}</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:#6B7280;padding:5px 0">Contacted</td>
            <td style="padding:5px 8px">${bar(pipelineContacted, '#F59E0B')}</td>
            <td style="font-size:12px;font-weight:700;color:#F59E0B;text-align:right">${pipelineContacted}</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:#6B7280;padding:5px 0">Converted</td>
            <td style="padding:5px 8px">${bar(pipelineConverted, '#10B981')}</td>
            <td style="font-size:12px;font-weight:700;color:#10B981;text-align:right">${pipelineConverted}</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:#6B7280;padding:5px 0">Lost</td>
            <td style="padding:5px 8px">${bar(pipelineLost, '#D1D5DB')}</td>
            <td style="font-size:12px;font-weight:700;color:#9CA3AF;text-align:right">${pipelineLost}</td>
          </tr>
        </table>
        <div style="margin-top:12px;font-size:13px;color:#6B7280">${convRate}% conversion rate this month</div>
      </td></tr>

      <!-- FOOTER -->
      <tr><td style="padding:24px 32px;margin-top:24px;background:#F9FAFB;border-top:1px solid #E5E7EB;text-align:center">
        <div style="font-size:12px;color:#9CA3AF">This report was automatically generated by LeadPulse AI</div>
        <div style="font-size:12px;color:#9CA3AF;margin-top:4px">
          Dashboard: <a href="${renderUrl}/dashboard" style="color:#3D7FFA;text-decoration:none">${renderUrl}/dashboard</a>
        </div>
        <div style="font-size:12px;color:#9CA3AF;margin-top:4px">Report generated at 8:00 AM UAE Time</div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

module.exports = { generateDailyEmailReport };
