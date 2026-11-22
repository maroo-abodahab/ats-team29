// One fetch wrapper for every API call in the frontend.
// - adds the JWT (Authorization: Bearer ...) when the user is logged in;
// - turns error responses into an ApiError with the server's code, message and field details;
// - on 401 (expired/invalid token) clears the session and sends the user to the login page.
// The token is kept in sessionStorage: it disappears when the tab is closed and is never
// put in a URL. Trade-off documented in the report (an XSS bug could read it, which is why
// the UI never inserts user text as HTML).
class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details || [];
  }
}

const Session = {
  KEY: 'ats.session',
  get() {
    try {
      const s = JSON.parse(sessionStorage.getItem(this.KEY));
      if (s && s.expiresAt > Date.now()) return s;
    } catch { /* ignore */ }
    sessionStorage.removeItem(this.KEY);
    return null;
  },
  save(token, user, expiresInSeconds = 3600) {
    sessionStorage.setItem(this.KEY, JSON.stringify({ token, user, expiresAt: Date.now() + expiresInSeconds * 1000 - 30_000 }));
  },
  clear() { sessionStorage.removeItem(this.KEY); },
  user() { return this.get()?.user || null; },
  role() { return this.get()?.user?.role || null; }
};

async function api(method, path, body, { query } = {}) {
  const session = Session.get();
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  let res;
  try {
    res = await fetch(`${API_ROOT}${path}${qs}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(session ? { Authorization: `Bearer ${session.token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError(0, { error: { code: 'NETWORK', message: 'Cannot reach the API. Is Floci running?' } });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && session) {
      Session.clear();
      window.dispatchEvent(new CustomEvent('ats:logout', { detail: 'Your session has expired. Please log in again.' }));
    }
    throw new ApiError(res.status, data);
  }
  return data;
}

// Reads a File object as base64 (for CV upload)
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}
