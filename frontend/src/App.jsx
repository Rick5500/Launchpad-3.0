import React, { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, CssBaseline, Box, Typography, TextField, Button, CircularProgress, Alert } from '@mui/material';
import AdminBoard from './routes/AdminBoard';
import PlaceholderPage from './routes/PlaceholderPage';
import SearchOrders from './routes/SearchOrders';
import ServicesPage from './routes/ServicesPage';
import UsersPage from './routes/UsersPage';
import SystemSettingsPage from './routes/SystemSettingsPage';
import ActivityLogPage from './routes/ActivityLogPage';
import BarcodeSettingsPage from './routes/BarcodeSettingsPage';
import WorkOrdersList from './routes/WorkOrdersList';
import WorkOrderDetail from './routes/WorkOrderDetail';
import WorkOrderForm from './routes/WorkOrderForm';
import DepartmentsAdmin from './routes/DepartmentsAdmin';
import Customers from './routes/Customers';
import ProductionBoard from './routes/ProductionBoard';
import BarcodeScan from './routes/BarcodeScan';
import Deliveries from './routes/Deliveries';
import CustomerOrderForm from './routes/CustomerOrderForm';
import OrderDetail from './routes/OrderDetail';
import WorkOrderPrint from './routes/WorkOrderPrint';
import Reports from './routes/Reports';
import Notifications from './routes/Notifications';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import { AuthProvider, useAuth } from './context/AuthContext';
import theme from './theme';
import { brand } from './brand';

function LoginScreen() {
  const { login, register, isLoggingIn, loginError, authMessage } = useAuth();
  const [mode, setMode] = useState('sign-in');
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [company, setCompany] = useState('');
  const [contactName, setContactName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [website, setWebsite] = useState('');
  const [localError, setLocalError] = useState('');
  const usernameRef = useRef(null);
  const companyRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/config')
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) return;
        if (!cancelled) setSignupEnabled(body.customer_self_signup_enabled === true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (mode === 'sign-in') usernameRef.current?.focus();
    else companyRef.current?.focus();
  }, [mode]);

  function showRegister() {
    setLocalError('');
    setMode('register');
  }

  function showSignIn() {
    setLocalError('');
    setMode('sign-in');
  }

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

  async function handleRegister(event) {
    event.preventDefault();
    setLocalError('');

    if (!company.trim() || !contactName.trim() || !email.trim() || !phone.trim()) {
      setLocalError('Company name, contact name, email, and phone are required.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setLocalError('Enter a valid email address. That email is your sign-in name.');
      return;
    }
    if (!/\d/.test(phone)) {
      setLocalError('Enter a phone number that includes a digit.');
      return;
    }
    if (newPassword.length < 8) {
      setLocalError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setLocalError('Password and confirmation do not match.');
      return;
    }

    await register({
      company: company.trim(),
      contact_name: contactName.trim(),
      email: email.trim(),
      phone: phone.trim(),
      password: newPassword,
      password_confirm: confirmPassword,
      website,
    });
  }

  const alertText = loginError || localError || authMessage;

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: brand.navy, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2.5, p: 2 }}>
      <Box
        component="img"
        src="/logo.png"
        alt="Accent Imaging"
        sx={{ width: { xs: 'min(100%, 420px)', sm: 450 }, height: 'auto', display: 'block' }}
      />
      <Box sx={{ width: 440, maxWidth: '100%', bgcolor: '#fff', borderRadius: 2, boxShadow: 6, overflow: 'hidden' }}>
        <Box sx={{ p: 4 }}>
        {mode === 'sign-in' ? (
          <>
            <Typography variant="h5" sx={{ color: brand.navy, fontWeight: 700, mb: 0.5 }}>
              Sign in
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              If you created an account here, sign in with your email.
            </Typography>
            <Box component="form" data-testid="sign-in-form" onSubmit={handleSubmit} sx={{ display: 'grid', gap: 2 }}>
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
              <Button type="submit" variant="contained" size="large" disabled={isLoggingIn} sx={{ bgcolor: brand.orange, '&:hover': { bgcolor: brand.orangeDark } }}>
                {isLoggingIn ? <CircularProgress size={24} color="inherit" /> : 'Login'}
              </Button>
              {signupEnabled ? (
                <Button type="button" data-testid="create-account-link" onClick={showRegister} sx={{ color: brand.orange }}>
                  Create an account
                </Button>
              ) : null}
            </Box>
          </>
        ) : (
          <>
            <Typography variant="h5" sx={{ color: brand.navy, fontWeight: 700, mb: 0.5 }}>
              Create an account
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Your account is ready to use right away. Sign in later with this email.
            </Typography>
            <Box component="form" data-testid="register-form" onSubmit={handleRegister} sx={{ display: 'grid', gap: 2, position: 'relative' }}>
              <Box aria-hidden="true" sx={{ position: 'absolute', left: '-10000px', top: 'auto', width: 1, height: 1, overflow: 'hidden' }}>
                <label>
                  Website
                  <input
                    tabIndex={-1}
                    autoComplete="off"
                    name="website"
                    value={website}
                    onChange={(event) => setWebsite(event.target.value)}
                  />
                </label>
              </Box>
              <TextField
                inputRef={companyRef}
                label="Company name"
                value={company}
                onChange={(event) => setCompany(event.target.value)}
                fullWidth
                autoComplete="organization"
                required
              />
              <TextField
                label="Contact name"
                value={contactName}
                onChange={(event) => setContactName(event.target.value)}
                fullWidth
                autoComplete="name"
                required
              />
              <TextField
                label="Email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                fullWidth
                autoComplete="email"
                required
                helperText="This email is your sign-in name."
              />
              <TextField
                label="Phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                fullWidth
                autoComplete="tel"
                required
              />
              <TextField
                label="Password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                fullWidth
                autoComplete="new-password"
                required
                helperText="At least 8 characters."
              />
              <TextField
                label="Confirm password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                fullWidth
                autoComplete="new-password"
                required
              />
              <Button type="submit" variant="contained" size="large" disabled={isLoggingIn} sx={{ bgcolor: brand.orange, '&:hover': { bgcolor: brand.orangeDark } }}>
                {isLoggingIn ? <CircularProgress size={24} color="inherit" /> : 'Create account'}
              </Button>
              <Button type="button" onClick={showSignIn} sx={{ color: brand.navy }}>
                Back to sign in
              </Button>
            </Box>
          </>
        )}
        {alertText && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {alertText}
          </Alert>
        )}
        </Box>
      </Box>
    </Box>
  );
}

function HomeOrOrder() {
  const { user } = useAuth();
  if (user?.role === 'customer') return <Navigate to="/order" replace />;
  return <AdminBoard />;
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
      <Route path="/login" element={user ? <Navigate to={user.role === 'customer' ? '/order' : '/'} replace /> : <LoginScreen />} />
      <Route path="/order" element={<ProtectedRoute roles={['admin', 'operator', 'manager', 'customer']}><CustomerOrderForm /></ProtectedRoute>} />
      <Route path="/orders/:id" element={<ProtectedRoute roles={['admin', 'operator', 'manager', 'customer']}><OrderDetail /></ProtectedRoute>} />
      <Route path="/orders/:id/print" element={<ProtectedRoute roles={['admin', 'operator', 'manager', 'customer']}><WorkOrderPrint /></ProtectedRoute>} />
      <Route path="/work-orders/:id/print" element={<ProtectedRoute roles={['admin', 'operator', 'manager', 'customer']}><WorkOrderPrint /></ProtectedRoute>} />
      <Route path="/" element={<Layout user={user} onLogout={logout} />}>
        <Route index element={<ProtectedRoute roles={['admin', 'operator', 'manager', 'customer']}><HomeOrOrder /></ProtectedRoute>} />
        <Route path="work-orders" element={<ProtectedRoute roles={['admin', 'operator', 'manager', 'customer']}><WorkOrdersList /></ProtectedRoute>} />
        <Route path="work-orders/new" element={<ProtectedRoute roles={['admin', 'operator', 'manager']}><WorkOrderForm /></ProtectedRoute>} />
        <Route path="work-orders/:id" element={<ProtectedRoute roles={['admin', 'operator', 'manager', 'customer']}><WorkOrderDetail /></ProtectedRoute>} />
        <Route path="work-orders/:id/edit" element={<ProtectedRoute roles={['admin', 'operator', 'manager']}><WorkOrderForm /></ProtectedRoute>} />
        <Route path="production-board" element={<ProtectedRoute roles={['admin', 'operator', 'manager']}><ProductionBoard /></ProtectedRoute>} />
        <Route path="scan" element={<ProtectedRoute roles={['admin', 'operator', 'manager']}><BarcodeScan /></ProtectedRoute>} />
        <Route path="customers" element={<ProtectedRoute roles={['admin']}><Customers /></ProtectedRoute>} />
        <Route path="delivery" element={<ProtectedRoute roles={['admin', 'operator', 'manager', 'customer']}><Deliveries /></ProtectedRoute>} />
        <Route path="reports" element={<ProtectedRoute roles={['admin', 'operator', 'manager']}><Reports /></ProtectedRoute>} />
        <Route path="reports/:reportId" element={<ProtectedRoute roles={['admin', 'operator', 'manager']}><Reports /></ProtectedRoute>} />
        <Route path="notifications" element={<ProtectedRoute roles={['admin', 'operator', 'manager', 'customer']}><Notifications /></ProtectedRoute>} />
        <Route path="search" element={<ProtectedRoute roles={['admin', 'operator', 'manager']}><SearchOrders /></ProtectedRoute>} />
        <Route path="services" element={<ProtectedRoute roles={['admin']}><ServicesPage /></ProtectedRoute>} />
        <Route path="users" element={<ProtectedRoute roles={['admin']}><UsersPage /></ProtectedRoute>} />
        <Route path="settings" element={<ProtectedRoute roles={['admin']}><SystemSettingsPage /></ProtectedRoute>} />
        <Route path="activity-log" element={<ProtectedRoute roles={['admin']}><ActivityLogPage /></ProtectedRoute>} />
        <Route path="barcode-settings" element={<ProtectedRoute roles={['admin']}><BarcodeSettingsPage /></ProtectedRoute>} />
        <Route path="admin" element={<ProtectedRoute roles={['admin']}><PlaceholderPage title="Admin" /></ProtectedRoute>} />
        <Route path="admin/departments" element={<ProtectedRoute roles={['admin']}><DepartmentsAdmin /></ProtectedRoute>} />
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
