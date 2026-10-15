import React, { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, CssBaseline, Box, Typography, TextField, Button, CircularProgress, Alert } from '@mui/material';
import HomeDashboard from './routes/HomeDashboard';
import PlaceholderPage from './routes/PlaceholderPage';
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
import Reports from './routes/Reports';
import Notifications from './routes/Notifications';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import { AuthProvider, useAuth } from './context/AuthContext';
import theme from './theme';
import { brand } from './brand';

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
    <Box sx={{ minHeight: '100vh', bgcolor: brand.navy, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Box sx={{ width: 440, maxWidth: '100%', bgcolor: '#fff', borderRadius: 2, boxShadow: 6, overflow: 'hidden' }}>
        <Box sx={{ bgcolor: '#fff', px: 3, pt: 3, textAlign: 'center' }}>
          <Box component="img" src="/logo.png" alt="LaunchPad 3.0" sx={{ width: 280, maxWidth: '100%', height: 'auto' }} />
        </Box>
        <Box sx={{ p: 4, pt: 1 }}>
        <Typography variant="h5" sx={{ color: brand.navy, fontWeight: 700, mb: 2 }}>
          Sign in
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
          <Button type="submit" variant="contained" size="large" disabled={isLoggingIn} sx={{ bgcolor: brand.orange, '&:hover': { bgcolor: brand.orangeDark } }}>
            {isLoggingIn ? <CircularProgress size={24} color="inherit" /> : 'Login'}
          </Button>
        </Box>
        {(loginError || localError || authMessage) && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {loginError || localError || authMessage}
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
  return <HomeDashboard />;
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
      <Route path="/order" element={<ProtectedRoute roles={['admin', 'operator', 'customer']}><CustomerOrderForm /></ProtectedRoute>} />
      <Route path="/orders/:id" element={<ProtectedRoute roles={['admin', 'operator', 'customer']}><OrderDetail /></ProtectedRoute>} />
      <Route path="/" element={<Layout user={user} onLogout={logout} />}>
        <Route index element={<ProtectedRoute roles={['admin', 'operator', 'customer']}><HomeOrOrder /></ProtectedRoute>} />
        <Route path="work-orders" element={<ProtectedRoute roles={['admin', 'operator', 'customer']}><WorkOrdersList /></ProtectedRoute>} />
        <Route path="work-orders/new" element={<ProtectedRoute roles={['admin', 'operator']}><WorkOrderForm /></ProtectedRoute>} />
        <Route path="work-orders/:id" element={<ProtectedRoute roles={['admin', 'operator', 'customer']}><WorkOrderDetail /></ProtectedRoute>} />
        <Route path="work-orders/:id/edit" element={<ProtectedRoute roles={['admin', 'operator']}><WorkOrderForm /></ProtectedRoute>} />
        <Route path="production-board" element={<ProtectedRoute roles={['admin', 'operator']}><ProductionBoard /></ProtectedRoute>} />
        <Route path="scan" element={<ProtectedRoute roles={['admin', 'operator']}><BarcodeScan /></ProtectedRoute>} />
        <Route path="customers" element={<ProtectedRoute roles={['admin']}><Customers /></ProtectedRoute>} />
        <Route path="delivery" element={<ProtectedRoute roles={['admin', 'operator', 'customer']}><Deliveries /></ProtectedRoute>} />
        <Route path="reports" element={<ProtectedRoute roles={['admin', 'operator']}><Reports /></ProtectedRoute>} />
        <Route path="notifications" element={<ProtectedRoute roles={['admin', 'operator', 'customer']}><Notifications /></ProtectedRoute>} />
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
