import React, { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, CssBaseline, Box, Typography, TextField, Button, CircularProgress, Alert } from '@mui/material';
import HomeDashboard from './routes/HomeDashboard';
import PlaceholderPage from './routes/PlaceholderPage';
import WorkOrdersList from './routes/WorkOrdersList';
import WorkOrderDetail from './routes/WorkOrderDetail';
import WorkOrderForm from './routes/WorkOrderForm';
import DepartmentsAdmin from './routes/DepartmentsAdmin';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import { AuthProvider, useAuth } from './context/AuthContext';
import theme from './theme';

function LoginScreen() {
  const { login, isLoggingIn, loginError, authMessage } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const usernameRef = useRef(null);

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    setLocalError('');

    if (!username.trim()) {
      setLocalError('Please enter your username.');
      usernameRef.current?.focus();
      return;
    }

    if (!password) {
      setLocalError('Please enter your password.');
      return;
    }

    await login(username.trim(), password);
  }

  return (
    <Box sx={{ fontFamily: 'sans-serif', p: 4, minHeight: '100vh', bgcolor: 'background.default' }}>
      <Box sx={{ maxWidth: 380, mx: 'auto', p: 4, bgcolor: 'background.paper', borderRadius: 2, boxShadow: 3 }}>
        <Typography variant="h4" gutterBottom>
          Launchpad 3.0 Login
        </Typography>
        <Box component="form" onSubmit={handleSubmit} sx={{ display: 'grid', gap: 2 }}>
          <TextField
            inputRef={usernameRef}
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            fullWidth
            autoComplete="username"
            variant="outlined"
          />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            fullWidth
            autoComplete="current-password"
            variant="outlined"
          />
          <Button type="submit" variant="contained" size="large" disabled={isLoggingIn}>
            {isLoggingIn ? <CircularProgress size={24} color="inherit" /> : 'Login'}
          </Button>
        </Box>
        {(loginError || localError || authMessage) && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {loginError || localError || authMessage}
          </Alert>
        )}
        <Typography sx={{ mt: 3 }} color="text.secondary">
          Demo credentials: <strong>admin / adminpass</strong>
        </Typography>
      </Box>
    </Box>
  );
}

function AppRoutes() {
  const { user, logout, isLoading } = useAuth();

  if (isLoading && !user) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginScreen />} />
      <Route path="/" element={<Layout user={user} onLogout={logout} />}>
        <Route index element={<ProtectedRoute><HomeDashboard /></ProtectedRoute>} />
        <Route path="work-orders" element={<ProtectedRoute><WorkOrdersList /></ProtectedRoute>} />
        <Route path="work-orders/new" element={<ProtectedRoute><WorkOrderForm /></ProtectedRoute>} />
        <Route path="work-orders/:id" element={<ProtectedRoute><WorkOrderDetail /></ProtectedRoute>} />
        <Route path="work-orders/:id/edit" element={<ProtectedRoute><WorkOrderForm /></ProtectedRoute>} />
        <Route path="production-board" element={<ProtectedRoute><PlaceholderPage title="Production Board" /></ProtectedRoute>} />
        <Route path="customers" element={<ProtectedRoute><PlaceholderPage title="Customers" /></ProtectedRoute>} />
        <Route path="delivery" element={<ProtectedRoute><PlaceholderPage title="Delivery" /></ProtectedRoute>} />
        <Route path="reports" element={<ProtectedRoute><PlaceholderPage title="Reports" /></ProtectedRoute>} />
        <Route path="admin" element={<ProtectedRoute><PlaceholderPage title="Admin" /></ProtectedRoute>} />
        <Route path="admin/departments" element={<ProtectedRoute><DepartmentsAdmin /></ProtectedRoute>} />
      </Route>
      <Route path="*" element={<Navigate to={user ? '/' : '/login'} replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
