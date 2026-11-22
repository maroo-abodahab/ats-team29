// Shared identity screens (owner: Marwan): login, register, navigation per role, logout.
// Hiding menu items by role is ONLY for convenience. Every action is checked again by
// the backend (401 / 403), so a user who types a hidden URL still gets refused.
const NAV = {
  guest: [['Jobs', '#/jobs'], ['Log in', '#/login'], ['Register', '#/register']],
  candidate: [['Jobs', '#/jobs'], ['My profile', '#/profile'], ['My applications', '#/my-applications']],
  recruiter: [['Jobs', '#/manage/jobs'], ['Pipeline', '#/pipeline'], ['Analytics', '#/analytics'], ['Departments', '#/departments'], ['Staff', '#/staff']],
  hiring_manager: [['My jobs', '#/manage/jobs'], ['Pipeline', '#/pipeline'], ['My interviews', '#/interviews'], ['Analytics', '#/analytics']]
};

function renderNav() {
  const user = Session.user();
  const items = NAV[user?.role || 'guest'];
  const current = location.hash.split('?')[0];
  document.getElementById('nav').replaceChildren(...items.map(([text, href]) => h('a', { href, class: current.startsWith(href) ? 'active' : '' }, text)));
  const s = document.getElementById('session');
  if (user) {
    s.replaceChildren(h('span', { class: 'who' }, user.name, ' ', badge(user.role, 'role')), button('Log out', logout, 'btn btn-ghost'));
  } else s.replaceChildren();
}

function logout() {
  Session.clear();
  toast('You are logged out.');
  location.hash = '#/login';
  renderNav();
}

function homeFor(role) {
  return { candidate: '#/jobs', recruiter: '#/manage/jobs', hiring_manager: '#/manage/jobs' }[role] || '#/jobs';
}

function loginView() {
  const form = h('form', { class: 'form narrow', novalidate: true },
    field('Email', input('email', { type: 'email', autocomplete: 'username', required: true })),
    field('Password', input('password', { type: 'password', autocomplete: 'current-password', required: true, maxlength: 72 })),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Log in'),
    h('p', { class: 'muted' }, 'New candidate? ', link('Create an account', '#/register')));
  onSubmit(form, async (values) => {
    const { token, user, expiresIn } = await api('POST', '/api/auth/login', values);
    Session.save(token, user, expiresIn);
    toast(`Welcome back, ${user.name}!`, 'success');
    renderNav();
    const back = sessionStorage.getItem('ats.after-login');
    sessionStorage.removeItem('ats.after-login');
    location.hash = back || homeFor(user.role);
  });
  render(card('Log in', form));
}

function registerView() {
  const form = h('form', { class: 'form narrow', novalidate: true },
    field('Full name', input('name', { required: true, minlength: 2, maxlength: 80, autocomplete: 'name' })),
    field('Email', input('email', { type: 'email', required: true, autocomplete: 'email' })),
    field('Password', input('password', { type: 'password', required: true, minlength: 8, maxlength: 72, autocomplete: 'new-password' }), '8+ characters with at least one letter and one number'),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create candidate account'),
    h('p', { class: 'muted small' }, 'Recruiter and hiring-manager accounts are created by a recruiter, not here.'));
  onSubmit(form, async (values) => {
    const { token, user } = await api('POST', '/api/auth/register', values);
    Session.save(token, user, 3600);
    toast('Account created. Next: complete your profile and upload your CV.', 'success');
    renderNav();
    location.hash = '#/profile';
  });
  render(card('Create a candidate account', form));
}

// Pages call this first. Not logged in -> login page. Wrong role -> friendly message.
function requireLogin(...roles) {
  const user = Session.user();
  if (!user) {
    sessionStorage.setItem('ats.after-login', location.hash);
    location.hash = '#/login';
    return null;
  }
  if (roles.length && !roles.includes(user.role)) {
    render(card('Not available', h('p', {}, `This page is not available for the ${label(user.role)} role.`), link('Go to my home page', homeFor(user.role), 'btn')));
    return null;
  }
  return user;
}

window.addEventListener('ats:logout', (e) => { toast(e.detail, 'error'); renderNav(); location.hash = '#/login'; });
