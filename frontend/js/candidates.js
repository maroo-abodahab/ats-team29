// Candidates & Applications pages (owner: Laila)
//   #/profile              candidate: profile form + CV upload / download
//   #/my-applications      candidate: my applications, progress, withdraw
//   (apply form)           shown on #/jobs/:id for candidates (renderApplyForm)
//   #/applicants/:jobId    recruiter / assigned hiring manager: search applicants of a job
//   #/candidates/:id       staff: a candidate's profile + CV download
const SOURCES = [['careers_site', 'Our careers site'], ['linkedin', 'LinkedIn'], ['referral', 'Referral'], ['job_board', 'Job board'], ['university', 'University / career fair'], ['other', 'Other']];
const PROGRESS = ['applied', 'screening', 'shortlisted', 'interview', 'offer', 'hired'];
const MAX_CV_BYTES = 2 * 1024 * 1024;

async function loadMyProfile() {
  try { return (await api('GET', '/api/candidates/me')).profile; } catch (err) { if (err.status === 404) return null; throw err; }
}

async function renderApplyForm(job) {
  if (job.status !== 'published') return card('Applications closed', h('p', {}, 'This job is not accepting applications.'));
  const [profile, mine] = await Promise.all([loadMyProfile(), api('GET', '/api/applications/me')]);
  const existing = mine.items.find((a) => a.jobId === job.jobId);
  if (existing) return card('You applied', h('p', {}, 'Current stage: ', badge(existing.currentStage)), link('View my applications', '#/my-applications', 'btn'));
  if (!profile || !profile.cv) {
    return card('Before you apply', h('p', {}, !profile ? 'Create your candidate profile and upload your CV first.' : 'Upload your CV first.'), link('Complete my profile', '#/profile', 'btn btn-primary'));
  }
  const sourceSelect = select('source', [['', 'How did you hear about this job?'], ...SOURCES], { required: true });
  const detail = field('Referrer name', input('sourceDetail', { maxlength: 120 }), 'Required for referrals');
  detail.hidden = true;
  sourceSelect.addEventListener('change', () => { detail.hidden = sourceSelect.value !== 'referral'; });
  const form = h('form', { class: 'form', novalidate: true },
    field('Source', sourceSelect), detail,
    field('Cover letter', textarea('coverLetter', { maxlength: 3000, rows: 6, placeholder: 'Why are you a good fit? (optional)' })),
    field('Expected salary (EGP/month)', input('expectedSalary', { type: 'number', min: 0 })),
    h('p', { class: 'muted small' }, `Your CV "${profile.cv.fileName}" will be attached.`),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Submit application'));
  onSubmit(form, async (values) => {
    if (values.source !== 'referral') delete values.sourceDetail;
    await api('POST', '/api/applications', { jobId: job.jobId, ...values });
    toast('Application submitted! A confirmation email is on its way.', 'success');
    location.hash = '#/my-applications';
  });
  return card('Apply for this job', form);
}

async function profileView() {
  if (!requireLogin('candidate')) return;
  const p = (await loadMyProfile()) || {};
  const form = h('form', { class: 'form grid-2', novalidate: true },
    field('Full name', input('fullName', { required: true, minlength: 2, maxlength: 80, value: p.fullName || Session.user().name })),
    field('Phone', input('phone', { required: true, value: p.phone || '', placeholder: '+20 10 1234 5678' })),
    field('Location', input('location', { maxlength: 80, value: p.location || '' })),
    field('Years of experience', input('yearsExperience', { type: 'number', min: 0, max: 60, value: p.yearsExperience ?? '' })),
    h('div', { class: 'span-2' }, field('Headline', input('headline', { maxlength: 120, value: p.headline || '', placeholder: 'e.g. Junior backend developer' }))),
    h('div', { class: 'span-2' }, field('Skills', input('skills', { value: (p.skills || []).join(', '), placeholder: 'Node.js, SQL, AWS' }), 'Separate with commas (max 30)')),
    h('div', { class: 'span-2' }, field('LinkedIn', input('linkedinUrl', { value: p.linkedinUrl || '', placeholder: 'https://linkedin.com/in/your-name' }))),
    h('div', { class: 'span-2' }, field('Summary', textarea('summary', { maxlength: 2000, value: p.summary || '' }))),
    h('div', { class: 'span-2' }, h('button', { type: 'submit', class: 'btn btn-primary' }, p.userId ? 'Save profile' : 'Create profile')));
  onSubmit(form, async (values) => {
    if (values.skills !== undefined) values.skills = values.skills.split(',').map((s) => s.trim()).filter(Boolean);
    await api('PUT', '/api/candidates/me', values);
    toast('Profile saved.', 'success');
    route();
  });

  // CV upload: checked here for convenience, checked again (content, type, size) by the server
  const fileInput = h('input', { type: 'file', name: 'cv', accept: '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const uploadBtn = button(p.cv ? 'Replace CV' : 'Upload CV', async () => {
    const file = fileInput.files[0];
    if (!file) return toast('Choose a PDF or DOCX file first.', 'error');
    if (file.size > MAX_CV_BYTES) return toast('The CV must be 2 MB or smaller.', 'error');
    uploadBtn.disabled = true;
    try {
      const contentType = file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      await api('PUT', '/api/candidates/me/cv', { fileName: file.name, contentType, contentBase64: await fileToBase64(file) });
      toast('CV uploaded.', 'success');
      route();
    } catch (err) { showError(err); } finally { uploadBtn.disabled = false; }
  }, 'btn btn-primary');
  const download = async () => {
    try { const { url } = await api('GET', '/api/candidates/me/cv'); window.open(url, '_blank', 'noopener'); } catch (err) { showError(err); }
  };
  const cvCard = card('CV',
    p.cv ? h('p', {}, h('strong', {}, p.cv.fileName), ` · ${(p.cv.size / 1024).toFixed(0)} KB · uploaded ${fmtDate(p.cv.uploadedAt)} `, button('Download', download, 'btn btn-small')) : h('p', { class: 'muted' }, 'No CV uploaded yet.'),
    p.userId ? h('div', { class: 'upload' }, fileInput, uploadBtn) : h('p', { class: 'muted' }, 'Save your profile first, then upload your CV.'),
    h('p', { class: 'muted small' }, 'PDF or DOCX, max 2 MB. Stored privately and encrypted; only recruiters and the hiring manager of a job you are shortlisted for can open it.'));
  render(pageHeader('My profile', 'Recruiters see this information when you apply.'), h('div', { class: 'two-col wide-left' }, card('Profile', form), cvCard));
}

function progressTracker(stage) {
  if (['rejected', 'withdrawn'].includes(stage)) return h('div', { class: 'tracker' }, badge(stage));
  const reached = PROGRESS.indexOf(stage);
  return h('ol', { class: 'tracker' }, PROGRESS.map((s, i) => h('li', { class: i < reached ? 'done' : i === reached ? 'current' : '' }, label(s))));
}

async function myApplicationsView() {
  if (!requireLogin('candidate')) return;
  const { items } = await api('GET', '/api/applications/me');
  const withdraw = (a) => async () => {
    if (!confirmAction(`Withdraw your application for "${a.jobTitle}"? This cannot be undone.`)) return;
    const reason = window.prompt('Reason (optional):') || undefined;
    try { await api('PATCH', `/api/applications/${a.applicationId}/withdraw`, reason ? { reason } : {}); toast('Application withdrawn.', 'success'); route(); } catch (err) { showError(err); }
  };
  render(pageHeader('My applications', 'Track every application from submission to decision.', link('Browse jobs', '#/jobs', 'btn')),
    items.length ? items.map((a) => card(null,
      h('div', { class: 'app-head' }, h('div', {}, h('h3', {}, link(a.jobTitle, `#/jobs/${a.jobId}`)), h('span', { class: 'muted small' }, `Applied ${fmtDate(a.submittedAt)} via ${label(a.source)} · updated ${fmtDate(a.stageUpdatedAt)}`)),
        ['hired', 'rejected', 'withdrawn'].includes(a.currentStage) ? null : button('Withdraw', withdraw(a), 'btn btn-small btn-danger')),
      progressTracker(a.currentStage))) : emptyState('You have not applied to any jobs yet.'));
}

async function openCv(candidateId) {
  try { const { url } = await api('GET', `/api/candidates/${candidateId}/cv`); window.open(url, '_blank', 'noopener'); } catch (err) { showError(err); }
}

async function applicantsView(jobId, params) {
  const user = requireLogin('recruiter', 'hiring_manager');
  if (!user) return;
  const query = { jobId, stage: params.get('stage'), source: params.get('source'), q: params.get('q') };
  const data = await api('GET', '/api/applications', undefined, { query });
  const filters = h('form', { class: 'filters' },
    input('q', { placeholder: 'Search name or email', value: query.q || '', maxlength: 80 }),
    select('stage', [['', 'All stages'], ...STAGE_ORDER.map((s) => [s, label(s)])], { selectedValue: query.stage || '' }),
    select('source', [['', 'All sources'], ...SOURCES], { selectedValue: query.source || '' }),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Filter'));
  filters.addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/applicants/${jobId}?${new URLSearchParams(formValues(filters))}`; });
  render(h('p', {}, link('← Jobs', '#/manage/jobs')),
    pageHeader(`Applicants: ${data.job.title}`, user.role === 'hiring_manager' ? 'Shortlisted candidates and later stages only.' : `${data.items.length} applicant(s)`, link('Open pipeline board', `#/pipeline/${jobId}`, 'btn')),
    filters,
    data.items.length ? h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['Candidate', 'Source', 'Stage', 'Applied', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, data.items.map((a) => h('tr', {},
        h('td', {}, link(a.candidateName, `#/candidates/${a.candidateId}`), h('div', { class: 'muted small' }, a.candidateEmail)),
        h('td', {}, label(a.source), a.sourceDetail ? h('div', { class: 'muted small' }, a.sourceDetail) : null),
        h('td', {}, badge(a.currentStage)), h('td', {}, fmtDate(a.submittedAt)),
        h('td', { class: 'row-actions' }, button('CV', () => openCv(a.candidateId), 'btn btn-small'), link('Details', `#/applications/${a.applicationId}`, 'btn btn-small')))))) : emptyState('No applicants match.'));
}

async function candidateProfileView(id) {
  if (!requireLogin('recruiter', 'hiring_manager')) return;
  const { profile: p } = await api('GET', `/api/candidates/${encodeURIComponent(id)}`);
  render(h('p', {}, button('← Back', () => history.back(), 'btn btn-ghost')),
    card(p.fullName,
      h('p', { class: 'muted' }, p.headline || ''),
      h('dl', { class: 'facts' },
        h('dt', {}, 'Email'), h('dd', {}, p.email), h('dt', {}, 'Phone'), h('dd', {}, p.phone),
        h('dt', {}, 'Location'), h('dd', {}, p.location || '—'), h('dt', {}, 'Experience'), h('dd', {}, p.yearsExperience != null ? `${p.yearsExperience} years` : '—'),
        h('dt', {}, 'Skills'), h('dd', {}, (p.skills || []).map((s) => h('span', { class: 'chip' }, s))),
        h('dt', {}, 'LinkedIn'), h('dd', {}, p.linkedinUrl ? h('a', { href: p.linkedinUrl, target: '_blank', rel: 'noopener noreferrer' }, p.linkedinUrl) : '—')),
      p.summary ? h('p', { class: 'pre' }, p.summary) : null,
      p.cv ? button(`Download CV (${p.cv.fileName})`, () => openCv(id), 'btn btn-primary') : h('p', { class: 'muted' }, 'No CV.')));
}
