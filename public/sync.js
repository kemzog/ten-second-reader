// Stores reading history and excluded feeds in a private GitHub repo so they
// sync between devices and Claude can read them. Everything works offline:
// events wait in localStorage until a token is set and a push succeeds.
const DATA = { owner: 'kemzog', repo: 'ten-second-reader-data', branch: 'main' };
const API = `https://api.github.com/repos/${DATA.owner}/${DATA.repo}/contents/`;
const TOKEN_KEY = 'gh-token';
const OUTBOX_KEY = 'outbox';
const EXCLUDED_KEY = 'excluded';
const EXCLUDED_DIRTY_KEY = 'excluded-dirty';
const OUTBOX_MAX = 2000;

const read = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

export const getToken = () => read(TOKEN_KEY, '');
export const setToken = (t) => write(TOKEN_KEY, t.trim());
export const pendingCount = () => read(OUTBOX_KEY, []).length;

// --- excluded feeds: { [category]: [sourceName, ...] } ---

export const getExcluded = () => read(EXCLUDED_KEY, {});

export function setExcluded(category, source, excluded) {
  const all = getExcluded();
  const set = new Set(all[category] ?? []);
  if (excluded) set.add(source);
  else set.delete(source);
  all[category] = [...set].sort();
  write(EXCLUDED_KEY, all);
  write(EXCLUDED_DIRTY_KEY, true);
  logEvent({ type: excluded ? 'exclude' : 'include', category, source });
}

// --- history events ---

export function logEvent(event) {
  const outbox = read(OUTBOX_KEY, []);
  outbox.push({ t: new Date().toISOString(), ...event });
  write(OUTBOX_KEY, outbox.slice(-OUTBOX_MAX));
  flush();
}

// --- GitHub contents API ---

export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
export function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function gh(path, init = {}) {
  return fetch(API + path + (init.method ? '' : `?ref=${DATA.branch}`), {
    cache: 'no-store',
    ...init,
    headers: {
      authorization: `Bearer ${getToken()}`,
      accept: 'application/vnd.github+json',
      ...init.headers,
    },
  });
}

async function getFile(path) {
  const res = await gh(path);
  if (res.status === 404) return { text: null, sha: undefined };
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  const json = await res.json();
  return { text: fromBase64(json.content), sha: json.sha };
}

async function putFile(path, text, sha, message) {
  const res = await gh(path, {
    method: 'PUT',
    body: JSON.stringify({ message, content: toBase64(text), sha, branch: DATA.branch }),
  });
  if (!res.ok) throw new Error(`PUT ${path}: ${res.status}`);
}

// Read-modify-write with one retry when another device wrote in between.
async function update(path, change, message) {
  for (let attempt = 0; ; attempt++) {
    const { text, sha } = await getFile(path);
    try {
      await putFile(path, change(text), sha, message);
      return;
    } catch (e) {
      if (attempt > 0 || !/: (409|422)$/.test(e.message)) throw e;
    }
  }
}

let flushing = null;

export function flush() {
  if (!getToken()) return Promise.resolve();
  flushing ??= doFlush().finally(() => (flushing = null));
  return flushing;
}

async function doFlush() {
  // One file per month keeps each file small enough for the contents API.
  // The outbox is in time order, so each month is a prefix once earlier ones are sent.
  let outbox;
  while ((outbox = read(OUTBOX_KEY, [])).length) {
    const month = outbox[0].t.slice(0, 7);
    const end = outbox.findIndex((e) => e.t.slice(0, 7) !== month);
    const events = end === -1 ? outbox : outbox.slice(0, end);
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await update(`history/${month}.jsonl`, (text) => (text ?? '') + lines, `history: ${events.length} events`);
    // Re-read so anything logged while we were pushing is kept.
    write(OUTBOX_KEY, read(OUTBOX_KEY, []).slice(events.length));
  }
  if (read(EXCLUDED_DIRTY_KEY, false)) {
    const json = JSON.stringify(getExcluded(), null, 2) + '\n';
    await update('excluded.json', () => json, 'update excluded feeds');
    write(EXCLUDED_DIRTY_KEY, false);
  }
}

// Pull excluded feeds set from another device. Local unsent changes win.
export async function pullExcluded() {
  if (!getToken() || read(EXCLUDED_DIRTY_KEY, false)) return false;
  const { text } = await getFile('excluded.json');
  if (text == null) return false;
  const remote = JSON.parse(text);
  const changed = JSON.stringify(remote) !== JSON.stringify(getExcluded());
  write(EXCLUDED_KEY, remote);
  return changed;
}
