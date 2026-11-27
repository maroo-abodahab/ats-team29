// Shared helpers for the integration and security tests.
// Tests run against the DEPLOYED app (API Gateway on Floci by default):
//   node --test --test-concurrency=1 "tests/*.test.mjs"
//   API_URL=https://xxxx.execute-api.us-east-1.amazonaws.com node --test tests/   (real AWS)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function apiUrl() {
  if (process.env.API_URL) return process.env.API_URL.replace(/\/$/, '');
  const cfg = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'config.js'), 'utf8');
  return cfg.match(/const FLOCI_API = '([^']+)'/)[1];
}
export const API = apiUrl();

export function demoAccounts() {
  const file = path.join(ROOT, 'infra', 'demo-accounts.local.json');
  if (!fs.existsSync(file)) throw new Error('Run "node scripts/seed.js" first (creates the bootstrap recruiter).');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function call(method, url, { token, body, headers = {}, raw = false } = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    // The API rate-limits clients. Tests that are NOT about rate limiting wait and retry.
    if (res.status === 429 && !raw) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after') || 5) + 1) * 1000));
      continue;
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  throw new Error('Still rate limited after retries');
}

export const uid = () => crypto.randomBytes(4).toString('hex');
export const strongPassword = () => `Test-${crypto.randomBytes(6).toString('base64url')}7`;

export async function login(email, password) {
  const r = await call('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login ${email} -> ${r.status} ${JSON.stringify(r.data)}`);
  return { token: r.data.token, user: r.data.user };
}

export async function recruiter() {
  const a = demoAccounts().recruiter;
  return login(a.email, a.password);
}

export async function newCandidate(name = 'Test Candidate', { withProfile = true, withCv = true } = {}) {
  const email = `cand.${uid()}@ats-test.test`;
  const password = strongPassword();
  const r = await call('POST', '/api/auth/register', { body: { name, email, password } });
  if (r.status !== 201) throw new Error(`register -> ${r.status} ${JSON.stringify(r.data)}`);
  const c = { token: r.data.token, user: r.data.user, email, password };
  if (withProfile) await call('PUT', '/api/candidates/me', { token: c.token, body: { fullName: name, phone: '+20 100 000 0000', skills: ['Testing'] } });
  if (withCv) await call('PUT', '/api/candidates/me/cv', { token: c.token, body: { fileName: 'cv.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4\n% test cv\n%%EOF').toString('base64') } });
  return c;
}

export async function newStaff(recToken, role = 'hiring_manager') {
  const email = `staff.${uid()}@ats-test.test`;
  const password = strongPassword();
  const r = await call('POST', '/api/auth/staff', { token: recToken, body: { name: `Test ${role} ${uid()}`, email, password, role } });
  if (r.status !== 201) throw new Error(`staff -> ${r.status} ${JSON.stringify(r.data)}`);
  return { ...(await login(email, password)), email, password };
}

export async function newPublishedJob(recToken, hiringManagerId, extra = {}) {
  const deps = (await call('GET', '/api/departments')).data.items;
  let dept = deps[0];
  if (!dept) dept = (await call('POST', '/api/departments', { token: recToken, body: { name: `Dept ${uid()}` } })).data.department;
  const r = await call('POST', '/api/jobs', {
    token: recToken,
    body: { title: `Test Job ${uid()}`, description: 'A test job created by the automated integration tests. It has a long enough description to publish.', location: 'Cairo', employmentType: 'full_time', departmentId: dept.departmentId, hiringManagerId, openings: 1, ...extra }
  });
  if (r.status !== 201) throw new Error(`create job -> ${r.status} ${JSON.stringify(r.data)}`);
  const p = await call('PATCH', `/api/jobs/${r.data.job.jobId}/status`, { token: recToken, body: { status: 'published' } });
  if (p.status !== 200) throw new Error(`publish -> ${p.status} ${JSON.stringify(p.data)}`);
  return p.data.job;
}

// ---- Evidence recorder: every test adds a row; the table is written to evidence/ ----
export function recorder(fileName, title) {
  const rows = [];
  return {
    add(row) { rows.push(row); },
    write() {
      const out = path.join(ROOT, 'evidence', fileName);
      const header = `# ${title}\n\nRun: ${new Date().toISOString()} against \`${API}\`\n\n| ID | Owner | Scenario | Expected | Actual | Result | Evidence (response) |\n|---|---|---|---|---|---|---|\n`;
      const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const body = rows.map((r) => `| ${r.id} | ${r.owner} | ${esc(r.scenario)} | ${esc(r.expected)} | ${esc(r.actual)} | ${r.pass ? 'PASS' : 'FAIL'} | ${esc(r.evidence).slice(0, 220)} |`).join('\n');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, header + body + '\n');
    }
  };
}

export const brief = (r) => `${r.status} ${typeof r.data === 'object' ? JSON.stringify(r.data?.error || r.data).slice(0, 180) : String(r.data).slice(0, 120)}`;
