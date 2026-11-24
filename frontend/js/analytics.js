// Hiring Analytics dashboard (owner: Marwan)  #/analytics
// The three KPIs from the project brief: time-to-hire, candidates per stage and source
// of applicants, plus the stage funnel and average days per stage. Recruiters see every
// job; hiring managers only their own (enforced by the backend, not by this page).
const STAGE_ORDER = ['applied', 'screening', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];

function barList(rows, { valueLabel = (v) => v, max } = {}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return h('div', { class: 'bars' }, rows.map((r) => h('div', { class: 'bar-row' },
    h('span', { class: 'bar-label' }, r.label),
    h('span', { class: 'bar-track' }, h('span', { class: `bar-fill ${r.cls || ''}`, style: `width:${Math.round((r.value / top) * 100)}%` })),
    h('span', { class: 'bar-value' }, valueLabel(r.value, r)))));
}

const kpi = (title, value, hint) => h('div', { class: 'kpi' }, h('span', { class: 'kpi-value' }, value ?? '—'), h('span', { class: 'kpi-title' }, title), hint ? h('span', { class: 'kpi-hint' }, hint) : null);

async function analyticsView(params) {
  const user = requireLogin('recruiter', 'hiring_manager');
  if (!user) return;
  const scope = { jobId: params.get('jobId'), departmentId: params.get('departmentId'), from: params.get('from'), to: params.get('to') };
  const [jobsRes, depts, data] = await Promise.all([
    api('GET', '/api/jobs', undefined, { query: { limit: 50 } }),
    departments(),
    api('GET', '/api/analytics/overview', undefined, { query: { ...scope, from: scope.from ? new Date(scope.from).toISOString() : undefined, to: scope.to ? new Date(`${scope.to}T23:59:59`).toISOString() : undefined } })
  ]);
  const m = data.metrics;
  const myJobs = user.role === 'hiring_manager' ? jobsRes.items.filter((j) => j.hiringManagerId === user.userId) : jobsRes.items;

  const filters = h('form', { class: 'filters' },
    select('jobId', [['', 'All jobs'], ...myJobs.map((j) => [j.jobId, j.title])], { selectedValue: scope.jobId || '' }),
    user.role === 'recruiter' ? select('departmentId', [['', 'All departments'], ...depts.map((d) => [d.departmentId, d.name])], { selectedValue: scope.departmentId || '' }) : null,
    h('label', { class: 'inline-label' }, 'From ', input('from', { type: 'date', value: scope.from || '' })),
    h('label', { class: 'inline-label' }, 'To ', input('to', { type: 'date', value: scope.to || '' })),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Apply'));
  filters.addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/analytics?${new URLSearchParams(formValues(filters))}`; });

  const stageRows = STAGE_ORDER.map((s) => ({ label: label(s), value: m.candidatesPerStage[s] || 0, cls: `stage-${s}` }));
  const sourceTable = m.sources.length ? h('table', { class: 'table compact' },
    h('thead', {}, h('tr', {}, ['Source', 'Applicants', 'Share', 'Hires', 'Hire rate'].map((t) => h('th', {}, t)))),
    h('tbody', {}, m.sources.map((s) => h('tr', {}, h('td', {}, label(s.source)), h('td', {}, s.applications),
      h('td', {}, h('span', { class: 'mini-bar' }, h('span', { style: `width:${s.share}%` })), ` ${s.share}%`), h('td', {}, s.hires), h('td', {}, `${s.hireRate}%`)))))
    : emptyState('No applications in this scope.');

  const funnel = barList(m.funnel.map((f) => ({ label: label(f.stage), value: f.count, conversion: f.conversionFromApplied })), { valueLabel: (v, r) => `${v} (${r.conversion}%)`, max: m.funnel[0]?.count || 1 });
  const durations = Object.keys(m.stageDurations).length
    ? barList(STAGE_ORDER.filter((s) => m.stageDurations[s] !== undefined).map((s) => ({ label: label(s), value: m.stageDurations[s] })), { valueLabel: (v) => `${v} d` })
    : emptyState('Not enough stage history yet.');
  const tthByJob = m.timeToHire.byJob.length ? h('table', { class: 'table compact' },
    h('thead', {}, h('tr', {}, ['Job', 'Hires', 'Avg days to hire'].map((t) => h('th', {}, t)))),
    h('tbody', {}, m.timeToHire.byJob.map((j) => h('tr', {}, h('td', {}, j.title), h('td', {}, j.hires), h('td', {}, j.averageDays))))) : emptyState('No hires yet.');

  let snapshots = null;
  if (user.role === 'recruiter') {
    const snapForm = h('form', { class: 'form inline', novalidate: true }, input('label', { placeholder: 'Snapshot name, e.g. "End of November"', required: true, minlength: 3, maxlength: 80 }), h('button', { type: 'submit', class: 'btn' }, 'Save snapshot'));
    onSubmit(snapForm, async (v) => {
      await api('POST', '/api/analytics/snapshots', { label: v.label, ...Object.fromEntries(Object.entries(scope).filter(([k, val]) => val && (k === 'jobId' || k === 'departmentId'))) });
      toast('Snapshot saved to the database.', 'success'); route();
    });
    const { items } = await api('GET', '/api/analytics/snapshots');
    snapshots = card('Saved snapshots (compare over time)', snapForm, items.length ? h('table', { class: 'table compact' },
      h('thead', {}, h('tr', {}, ['Name', 'Taken', 'Applications', 'Hires', 'Avg time-to-hire'].map((t) => h('th', {}, t)))),
      h('tbody', {}, items.map((s) => h('tr', {}, h('td', {}, s.label), h('td', {}, fmtDateTime(s.takenAt)), h('td', {}, s.metrics.totalApplications),
        h('td', {}, s.metrics.timeToHire?.hires ?? 0), h('td', {}, s.metrics.timeToHire?.averageDays != null ? `${s.metrics.timeToHire.averageDays} d` : '—'))))) : emptyState('No snapshots yet.'));
  }

  render(
    pageHeader('Hiring analytics', user.role === 'hiring_manager' ? 'Your jobs only.' : 'All jobs. Data comes live from the jobs, candidates and pipeline services.'),
    filters,
    h('div', { class: 'kpis' },
      kpi('Applications', m.totalApplications),
      kpi('Hires', m.timeToHire.hires),
      kpi('Avg time-to-hire', m.timeToHire.averageDays != null ? `${m.timeToHire.averageDays} d` : null, m.timeToHire.medianDays != null ? `median ${m.timeToHire.medianDays} d` : 'no hires yet'),
      kpi('Open jobs', m.jobs.published, `${m.jobs.draft} draft · ${m.jobs.closed} closed`)),
    h('div', { class: 'two-col' },
      card('Candidates per stage', barList(stageRows)),
      card('Source of applicants', sourceTable)),
    h('div', { class: 'two-col' },
      card('Hiring funnel (reached each stage)', funnel),
      card('Average days spent in each stage', durations)),
    card('Time-to-hire by job', tthByJob),
    snapshots,
    h('p', { class: 'muted small' }, `Generated ${fmtDateTime(m.generatedAt)}`));
}
