export function clearStoredAuth(message = 'Your session has expired. Please log in again.') {
  localStorage.removeItem('lp_token');
  if (message) {
    sessionStorage.setItem('auth_message', message);
  }
}

function handleAuthExpired() {
  clearStoredAuth();
  window.dispatchEvent(new CustomEvent('auth:expired'));
  window.location.assign('/login');
}

export function authFetch(url, options = {}) {
  const token = localStorage.getItem('lp_token');
  const headers = { ...(options.headers || {}) };
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (!isForm && options.body != null && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return fetch(url, { ...options, headers }).then((response) => {
    if (response.status === 401) {
      handleAuthExpired();
    }
    return response;
  });
}

export async function downloadAuthorized(url, filename) {
  const response = await authFetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Download failed');
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename || 'download';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}
