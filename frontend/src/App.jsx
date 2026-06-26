import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, CssBaseline, Box, Typography, Avatar, Button } from '@mui/material';
import HomeDashboard from './routes/HomeDashboard';
import PlaceholderPage from './routes/PlaceholderPage';
import WorkOrdersList from './routes/WorkOrdersList';
import WorkOrderDetail from './routes/WorkOrderDetail';
import WorkOrderForm from './routes/WorkOrderForm';
import Layout from './components/Layout';
import theme from './theme';

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
        .catch(() => {
          setToken(null);
          localStorage.removeItem('lp_token');
        });
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
      .catch(() => setMessage('Network error'));
  }

  function logout() {
    localStorage.removeItem('lp_token');
    setToken(null);
    setUser(null);
    setUsername('');
    setPassword('');
  }

  if (!user) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box sx={{ fontFamily: 'sans-serif', p: 4, minHeight: '100vh', bgcolor: 'background.default' }}>
          <Box sx={{ maxWidth: 380, mx: 'auto', p: 4, bgcolor: 'background.paper', borderRadius: 2, boxShadow: 3 }}>
            <Typography variant="h4" gutterBottom>
              Launchpad 3.0 Login
            </Typography>
            <Box component="form" onSubmit={doLogin} sx={{ display: 'grid', gap: 2 }}>
              <input
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                style={{ width: '100%', padding: '12px', borderRadius: 8, border: '1px solid #333', background: '#121212', color: '#fff' }}
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ width: '100%', padding: '12px', borderRadius: 8, border: '1px solid #333', background: '#121212', color: '#fff' }}
              />
              <Button type="submit" variant="contained" size="large">
                Login
              </Button>
            </Box>
            {message && (
              <Typography sx={{ mt: 2 }} color="warning.main">
                {message}
              </Typography>
            )}
            <Typography sx={{ mt: 3 }} color="text.secondary">
              Demo credentials: <strong>admin / adminpass</strong>
            </Typography>
          </Box>
        </Box>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout user={user} onLogout={logout} />}>
            <Route index element={<HomeDashboard />} />
            <Route path="work-orders" element={<WorkOrdersList />} />
            <Route path="work-orders/new" element={<WorkOrderForm />} />
            <Route path="work-orders/:id" element={<WorkOrderDetail />} />
            <Route path="work-orders/:id/edit" element={<WorkOrderForm />} />
            <Route path="production-board" element={<PlaceholderPage title="Production Board" />} />
            <Route path="customers" element={<PlaceholderPage title="Customers" />} />
            <Route path="delivery" element={<PlaceholderPage title="Delivery" />} />
            <Route path="reports" element={<PlaceholderPage title="Reports" />} />
            <Route path="admin" element={<PlaceholderPage title="Admin" />} />
          </Route>
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
