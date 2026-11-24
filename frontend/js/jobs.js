// Job Management pages (owner: Marwan)
//   #/jobs                 browse + search published jobs (everyone)
//   #/jobs/:id             job details (+ apply form for candidates, from candidates.js)
//   #/manage/jobs          recruiter: all jobs + status actions | hiring manager: their jobs
//   #/manage/jobs/new      recruiter: create job
//   #/manage/jobs/:id      recruiter: edit job + status history
//   #/departments          recruiter: departments
//   #/staff                recruiter: staff accounts
const EMPLOYMENT = [['', 'Any type'], ['full_time', 'Full time'], ['part_time', 'Part time'], ['contract', 'Contract'], ['internship', 'Internship']];

let departmentCache = null;
async function departments(force = false) {
  if (!departmentCache || force) departmentCache = (await api('GET', '/api/departments')).items;
  return departmentCache;
}

function salary(job) {
  if (!job.salaryMin && !job.salaryMax) return null;
  return `EGP ${job.salaryMin?.toLocaleString() ?? '?'} – ${job.salaryMax?.toLocaleString() ?? '?'} / month`;
}

function jobMeta(job) {
  return h('div', { class: 'meta' },
    h('span', {}, job.departmentName), h('span', {}, job.location), h('span', {}, label(job.employmentType)),
    salary(job) ? h('span', {}, salary(job)) : null,
    job.closingDate ? h('span', {}, `Closes ${fmtDate(job.closingDate)}`) : null);
}

async function jobsBrowseView(params) {
  const depts = await departments();
  const query = { q: params.get('q'), departmentId: params.get('departmentId'), employmentType: params.get('employmentType'), location: params.get('location'), page: params.get('page') || 1, limit: 8 };
  const form = h('form', { class: 'filters' },
    input('q', { placeholder: 'Search title, description, department', value: query.q || '', maxlength: 100 }),
    select('departmentId', [['', 'All departments'], ...depts.map((d) => [d.departmentId, d.name])], { selectedValue: query.departmentId || '' }),
    select('employmentType', EMPLOYMENT, { selectedValue: query.employmentType || '' }),
    input('location', { placeholder: 'Location', value: query.location || '', maxlength: 80 }),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Search'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = new URLSearchParams(Object.entries(formValues(form)));
    location.hash = `#/jobs?${p}`;
  });

  const result = await api('GET', '/api/jobs', undefined, { query });
  const pages = Math.max(1, Math.ceil(result.total / result.limit));
  const list = result.items.length
    ? h('div', { class: 'job-grid' }, result.items.map((job) => h('a', { class: 'job-card', href: `#/jobs/${job.jobId}` },
      h('h3', {}, job.title), jobMeta(job), h('p', { class: 'clamp' }, job.description))))
    : emptyState('No jobs match your search.');
  const pager = h('div', { class: 'pager' },
    result.page > 1 ? link('← Previous', `#/jobs?${new URLSearchParams({ ...cleanQuery(query), page: result.page - 1 })}`, 'btn btn-ghost') : null,
    h('span', { class: 'muted' }, `Page ${result.page} of ${pages} · ${result.total} job(s)`),
    result.page < pages ? link('Next →', `#/jobs?${new URLSearchParams({ ...cleanQuery(query), page: result.page + 1 })}`, 'btn btn-ghost') : null);
  render(pageHeader('Open positions', 'Find your next role and apply in minutes.'), form, list, pager);
}
const cleanQuery = (q) => Object.fromEntries(Object.entries(q).filter(([k, v]) => v && k !== 'page' && k !== 'limit'));

async function jobDetailView(id) {
  const { job } = await api('GET', `/api/jobs/${encodeURIComponent(id)}`);
  const user = Session.user();
  let applyBox;
  if (!user) applyBox = card('Interested?', h('p', {}, 'Log in or create a candidate account to apply.'), link('Log in', '#/login', 'btn btn-primary'), ' ', link('Register', '#/register', 'btn'));
  else if (user.role === 'candidate') applyBox = await renderApplyForm(job); // candidates.js (Laila)
  else applyBox = card('Staff tools', link('Manage this job', `#/manage/jobs/${job.jobId}`, 'btn'), ' ', link('Open pipeline', `#/pipeline/${job.jobId}`, 'btn'));
  render(
    h('p', {}, link('← All jobs', '#/jobs')),
    h('div', { class: 'two-col' },
      card(null, h('h1', {}, job.title), job.status !== 'published' ? badge(job.status) : null, jobMeta(job),
        h('h3', {}, 'About the role'), h('p', { class: 'pre' }, job.description),
        job.requirements ? [h('h3', {}, 'Requirements'), h('p', { class: 'pre' }, job.requirements)] : null),
      applyBox));
}

// ---- Recruiter / hiring manager -------------------------------------------
async function manageJobsView(params) {
  const user = requireLogin('recruiter', 'hiring_manager');
  if (!user) return;
  const status = params.get('status') || '';
  const result = await api('GET', '/api/jobs', undefined, { query: { status, limit: 50 } });
  let items = result.items;
  const mineOnly = user.role === 'hiring_manager';
  if (mineOnly) items = items.filter((j) => j.hiringManagerId === user.userId);

  const filter = select('status', [['', 'All statuses'], ['draft', 'Draft'], ['published', 'Published'], ['closed', 'Closed']], { selectedValue: status });
  filter.addEventListener('change', () => { location.hash = `#/manage/jobs${filter.value ? `?status=${filter.value}` : ''}`; });

  const rows = items.map((job) => h('tr', {},
    h('td', {}, link(job.title, `#/jobs/${job.jobId}`), h('div', { class: 'muted small' }, job.departmentName)),
    h('td', {}, badge(job.status)),
    h('td', {}, `${job.hiredCount}/${job.openings}`),
    h('td', {}, fmtDate(job.createdAt)),
    h('td', { class: 'row-actions' },
      user.role === 'recruiter' && job.status !== 'closed' ? link('Edit', `#/manage/jobs/${job.jobId}`, 'btn btn-small') : null,
      user.role === 'recruiter' ? statusButtons(job) : null,
      job.status !== 'draft' ? link('Pipeline', `#/pipeline/${job.jobId}`, 'btn btn-small') : null,
      job.status !== 'draft' ? link('Applicants', `#/applicants/${job.jobId}`, 'btn btn-small') : null)));

  render(
    pageHeader(mineOnly ? 'My jobs' : 'Jobs', mineOnly ? 'Jobs where you are the hiring manager.' : 'Create jobs and control their status: draft → published → closed.',
      filter, user.role === 'recruiter' ? link('+ New job', '#/manage/jobs/new', 'btn btn-primary') : null),
    items.length ? h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Job', 'Status', 'Hired', 'Created', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows)) : emptyState('No jobs yet.'));
}

function statusButtons(job) {
  const change = async (status) => {
    let reason;
    if (status === 'closed') {
      reason = window.prompt('Why is this job being closed? (required)');
      if (!reason) return;
    }
    try {
      await api('PATCH', `/api/jobs/${job.jobId}/status`, { status, ...(reason ? { reason } : {}) });
      toast(`Job ${status === 'draft' ? 'unpublished' : status}.`, 'success');
      route();
    } catch (err) { showError(err); }
  };
  const buttons = [];
  if (job.status === 'draft') buttons.push(button('Publish', () => change('published'), 'btn btn-small btn-primary'));
  if (job.status === 'published') buttons.push(button('Unpublish', () => change('draft'), 'btn btn-small'));
  if (job.status !== 'closed') buttons.push(button('Close', () => change('closed'), 'btn btn-small btn-danger'));
  return buttons;
}

async function jobFormView(id) {
  if (!requireLogin('recruiter')) return;
  const [depts, staff, existing] = await Promise.all([
    departments(true),
    api('GET', '/api/auth/staff', undefined, { query: { role: 'hiring_manager' } }),
    id ? api('GET', `/api/jobs/${encodeURIComponent(id)}`).then((r) => r.job) : null
  ]);
  const j = existing || {};
  const form = h('form', { class: 'form grid-2', novalidate: true },
    field('Title', input('title', { required: true, minlength: 3, maxlength: 120, value: j.title || '' })),
    field('Department', select('departmentId', [['', 'Choose…'], ...depts.map((d) => [d.departmentId, d.name])], { selectedValue: j.departmentId || '', required: true })),
    field('Hiring manager', select('hiringManagerId', [['', 'Not assigned yet'], ...staff.items.filter((s) => s.active).map((s) => [s.userId, s.name])], { selectedValue: j.hiringManagerId || '' }), 'Required before publishing'),
    field('Location', input('location', { required: true, maxlength: 80, value: j.location || '' })),
    field('Employment type', select('employmentType', EMPLOYMENT.slice(1), { selectedValue: j.employmentType || 'full_time' })),
    field('Openings', input('openings', { type: 'number', min: 1, max: 50, value: j.openings || 1 })),
    field('Salary from (EGP/month)', input('salaryMin', { type: 'number', min: 0, value: j.salaryMin ?? '' })),
    field('Salary to (EGP/month)', input('salaryMax', { type: 'number', min: 0, value: j.salaryMax ?? '' })),
    field('Closing date', input('closingDate', { type: 'date', value: j.closingDate || '' })),
    h('div', {}),
    h('div', { class: 'span-2' }, field('Description', textarea('description', { rows: 6, required: true, minlength: 20, maxlength: 5000, value: j.description || '' }), 'At least 50 characters to publish')),
    h('div', { class: 'span-2' }, field('Requirements', textarea('requirements', { maxlength: 3000, value: j.requirements || '' }))),
    h('div', { class: 'span-2' }, h('button', { type: 'submit', class: 'btn btn-primary' }, id ? 'Save changes' : 'Create draft job')));
  onSubmit(form, async (values) => {
    if (id) {
      await api('PUT', `/api/jobs/${id}`, values);
      toast('Job saved.', 'success');
    } else {
      const { job } = await api('POST', '/api/jobs', values);
      toast('Draft job created. Publish it when ready.', 'success');
      location.hash = `#/manage/jobs/${job.jobId}`;
      return;
    }
    route();
  });

  let history = null;
  if (id) {
    const { items } = await api('GET', `/api/jobs/${id}/history`);
    history = card('Status history', h('ul', { class: 'timeline' }, items.map((e) => h('li', {},
      h('strong', {}, `${e.fromStatus ? label(e.fromStatus) + ' → ' : ''}${label(e.toStatus)}`), ' ', h('span', { class: 'muted' }, fmtDateTime(e.changedAt)),
      e.reason ? h('div', { class: 'small' }, e.reason) : null))));
  }
  render(h('p', {}, link('← Jobs', '#/manage/jobs')),
    pageHeader(id ? `Edit: ${j.title}` : 'New job', id ? null : 'New jobs start as drafts; candidates cannot see them until published.', existing ? badge(existing.status) : null, existing ? statusButtons(existing) : null),
    card(null, form), history);
}

async function departmentsView() {
  if (!requireLogin('recruiter')) return;
  const items = await departments(true);
  const form = h('form', { class: 'form inline', novalidate: true },
    field('Name', input('name', { required: true, minlength: 2, maxlength: 80 })),
    field('Description', input('description', { maxlength: 300 })),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Add department'));
  onSubmit(form, async (values) => { await api('POST', '/api/departments', values); toast('Department added.', 'success'); route(); });
  const del = (d) => async () => {
    if (!confirmAction(`Delete department "${d.name}"?`)) return;
    try { await api('DELETE', `/api/departments/${d.departmentId}`); toast('Department deleted.', 'success'); route(); } catch (err) { showError(err); }
  };
  render(pageHeader('Departments', 'Departments group jobs and power the search filters.'), card('New department', form),
    h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Name', 'Description', 'Jobs', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, items.map((d) => h('tr', {}, h('td', {}, d.name), h('td', {}, d.description || '—'), h('td', {}, d.jobCount),
        h('td', {}, button('Delete', del(d), 'btn btn-small btn-danger')))))));
}

async function staffView() {
  if (!requireLogin('recruiter')) return;
  const me = Session.user();
  const { items } = await api('GET', '/api/auth/staff');
  const form = h('form', { class: 'form grid-2', novalidate: true },
    field('Full name', input('name', { required: true, minlength: 2, maxlength: 80 })),
    field('Email', input('email', { type: 'email', required: true })),
    field('Role', select('role', [['hiring_manager', 'Hiring manager'], ['recruiter', 'Recruiter']])),
    field('Temporary password', input('password', { type: 'password', required: true, minlength: 8, maxlength: 72, autocomplete: 'new-password' }), '8+ characters, letters and numbers'),
    h('div', { class: 'span-2' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create staff account')));
  onSubmit(form, async (values) => { await api('POST', '/api/auth/staff', values); toast('Staff account created.', 'success'); route(); });
  const toggle = (s) => async () => {
    try { await api('PATCH', `/api/auth/staff/${s.userId}/status`, { active: !s.active }); toast(`${s.name} ${s.active ? 'deactivated' : 'activated'}.`, 'success'); route(); } catch (err) { showError(err); }
  };
  render(pageHeader('Staff accounts', 'Only recruiters can create recruiter and hiring-manager accounts.'), card('New staff member', form),
    h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Status', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, items.map((s) => h('tr', {}, h('td', {}, s.name), h('td', {}, s.email), h('td', {}, badge(s.role, 'role')),
        h('td', {}, s.active ? badge('active') : badge('inactive')),
        h('td', {}, s.userId === me.userId ? h('span', { class: 'muted small' }, 'you') : button(s.active ? 'Deactivate' : 'Activate', toggle(s), 'btn btn-small')))))));
}
