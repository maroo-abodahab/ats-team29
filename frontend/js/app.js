// Hash router: one page per URL, shared navigation for all three services.
const ROUTES = [
  [/^#\/login$/, () => loginView()],
  [/^#\/register$/, () => registerView()],
  [/^#\/jobs$/, (m, q) => jobsBrowseView(q)],
  [/^#\/jobs\/([\w-]+)$/, (m) => jobDetailView(m[1])],
  [/^#\/manage\/jobs$/, (m, q) => manageJobsView(q)],
  [/^#\/manage\/jobs\/new$/, () => jobFormView()],
  [/^#\/manage\/jobs\/([\w-]+)$/, (m) => jobFormView(m[1])],
  [/^#\/departments$/, () => departmentsView()],
  [/^#\/staff$/, () => staffView()],
  [/^#\/analytics$/, (m, q) => analyticsView(q)],
  [/^#\/profile$/, () => profileView()],
  [/^#\/my-applications$/, () => myApplicationsView()],
  [/^#\/applicants\/([\w-]+)$/, (m, q) => applicantsView(m[1], q)],
  [/^#\/candidates\/([\w-]+)$/, (m) => candidateProfileView(m[1])],
  [/^#\/pipeline$/, () => pipelineIndexView()],
  [/^#\/pipeline\/([\w-]+)$/, (m) => boardView(m[1])],
  [/^#\/applications\/([\w-]+)$/, (m) => applicationDetailView(m[1])],
  [/^#\/interviews$/, () => myInterviewsView()]
];

function route() {
  const hash = location.hash || '#/jobs';
  const [path, qs] = hash.split('?');
  renderNav();
  for (const [pattern, handler] of ROUTES) {
    const m = path.match(pattern);
    if (m) return guarded(() => handler(m, new URLSearchParams(qs || '')));
  }
  render(card('Page not found', link('Go to jobs', '#/jobs', 'btn')));
  return undefined;
}

async function checkApi() {
  const el = document.getElementById('api-status');
  try {
    // plain GET with no headers: health checks are public and need no CORS preflight
    const results = await Promise.all(['jobs', 'candidates', 'pipeline'].map((s) => fetch(`${API_ROOT}/api/health/${s}`).then((r) => { if (!r.ok) throw new Error(); return r.json(); })));
    el.textContent = `API online: ${results.map((r) => `${r.service.replace('-service', '')} (${r.runtime})`).join(', ')}`;
    el.className = 'ok-text';
  } catch {
    el.textContent = 'API offline: start Docker Desktop and Floci';
    el.className = 'error-text';
  }
}

window.addEventListener('hashchange', route);
route();
checkApi();
