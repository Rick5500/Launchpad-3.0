import React, { useState, useEffect } from 'react';

export default function App() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState(localStorage.getItem('lp_token'));
  const [user, setUser] = useState(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (token) {
      fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((data) => {
          if (data && data.user) setUser(data.user);
        })
        .catch(() => {});
    }
  }, [token]);

  function doLogin(e) {
    e && e.preventDefault();
    setMessage('');
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
      .then((r) => r.json().then((b) => ({ ok: r.ok, body: b })))
      .then(({ ok, body }) => {
        if (!ok) return setMessage(body.error || 'Login failed');
        localStorage.setItem('lp_token', body.token);
        setToken(body.token);
        setUser(body.user);
        setMessage('Login successful');
      })
      .catch((err) => setMessage('Network error'));
  }

  function logout() {
    localStorage.removeItem('lp_token');
    setToken(null);
    setUser(null);
    setUsername('');
    setPassword('');
  }

  if (user) {
    return (
      <div style={{ fontFamily: 'sans-serif', padding: 20 }}>
        <h1>Welcome, {user.display_name || user.username}</h1>
        <p>Role: {user.role}</p>
        <p>This is a placeholder dashboard. Routes planned: /admin /customer /production</p>
        <button onClick={logout}>Logout</button>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'sans-serif', padding: 20 }}>
      <h1>Launchpad 3.0 — Login</h1>
      <form onSubmit={doLogin} style={{ maxWidth: 320 }}>
        <div style={{ marginBottom: 8 }}>
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} style={{ width: '100%' }} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} />
        </div>
        <div style={{ marginTop: 8 }}>
          <button type="submit">Login</button>
        </div>
      </form>
      {message && <p>{message}</p>}
      <p style={{ marginTop: 16 }}>Demo: initialize DB then use <strong>admin / adminpass</strong></p>
    </div>
  );
}
