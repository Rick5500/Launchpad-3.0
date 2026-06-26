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
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

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
