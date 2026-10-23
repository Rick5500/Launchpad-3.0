import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { keyframes } from '@emotion/react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
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
import SendProofPage from './routes/SendProofPage';
import CustomerProofsPage from './routes/CustomerProofsPage';
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
import SendFiles from './routes/SendFiles';
import EmailOrders from './routes/EmailOrders';
import CustomerFiles from './routes/CustomerFiles';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import { AuthProvider, useAuth } from './context/AuthContext';
import theme from './theme';
import { brand } from './brand';
import { safeAppPath } from './safePath';
import { useDocumentTitle } from './useDocumentTitle';

function returnPath(location) {
  const fromQuery = safeAppPath(new URLSearchParams(location.search).get('next'));
  if (fromQuery) return fromQuery;
  const from = location.state && location.state.from;
  if (!from || typeof from !== 'object') return '';
  return safeAppPath(`${from.pathname || ''}${from.search || ''}${from.hash || ''}`);
}

const INTRO_VIDEO = '/login-intro.mp4';
const INTRO_POSTER = '/login-intro-end.jpg';
const INTRO_SEEN_KEY = 'launchpad.signinIntroPlayed';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeToReducedMotion(onChange) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function reducedMotionSnapshot() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function readIntroSeen() {
  try {
    return sessionStorage.getItem(INTRO_SEEN_KEY) === '1';
  } catch (err) {
    return false;
  }
}

function markIntroSeen() {
  try {
    sessionStorage.setItem(INTRO_SEEN_KEY, '1');
  } catch (err) {
    // Private mode can block sessionStorage. The intro still finishes.
  }
}

function shouldSkipIntro() {
  if (typeof window === 'undefined') return true;
  try {
    if (window.matchMedia(REDUCED_MOTION_QUERY).matches) return true;
  } catch (err) {
    return false;
  }
  return readIntroSeen();
}

const darkFieldSx = {
  '& .MuiInputLabel-root': {
    color: 'rgba(255,255,255,0.86)',
    fontSize: '1.15rem',
  },
  '& .MuiInputLabel-root.Mui-focused': {
    color: brand.orange,
  },
  '& .MuiInputLabel-shrink': {
    fontSize: '1.15rem',
  },
  '& .MuiOutlinedInput-root': {
    color: '#fff',
    backgroundColor: brand.navy,
    fontSize: '1.2rem',
    '& fieldset': {
      borderColor: 'rgba(255,255,255,0.34)',
    },
    '&:hover fieldset': {
      borderColor: 'rgba(245,130,32,0.85)',
    },
    '&.Mui-focused': {
      boxShadow: '0 0 0 3px rgba(245, 130, 32, 0.45)',
    },
    '&.Mui-focused fieldset': {
      borderColor: brand.orange,
      borderWidth: 2,
    },
    '& input': {
      paddingTop: '16.5px',
      paddingBottom: '16.5px',
    },
  },
  '& .MuiFormHelperText-root': {
    color: 'rgba(255,255,255,0.82)',
    fontSize: '1.05rem',
    mx: 0,
  },
  '& input:-webkit-autofill, & input:-webkit-autofill:hover, & input:-webkit-autofill:focus, & input:-webkit-autofill:active': {
    WebkitTextFillColor: '#fff',
    caretColor: '#fff',
    transition: 'background-color 99999s ease-out',
    WebkitBoxShadow: `0 0 0 100px ${brand.navy} inset`,
  },
};

const titleSx = {
  color: '#fff',
  fontWeight: 700,
  mb: 1,
  fontSize: { xs: '1.85rem', sm: '2.05rem' },
  lineHeight: 1.2,
};

const subtitleSx = {
  color: 'rgba(255,255,255,0.9)',
  mb: 2.5,
  fontSize: { xs: '1.1rem', sm: '1.2rem' },
  lineHeight: 1.45,
};

const loginButtonSx = {
  bgcolor: brand.orange,
  color: '#fff',
  fontSize: '1.2rem',
  fontWeight: 700,
  py: 1.5,
  boxShadow: '0 8px 22px rgba(245, 130, 32, 0.28)',
  '&:hover': { bgcolor: brand.orangeDark },
  '&.Mui-disabled': {
    bgcolor: 'rgba(245, 130, 32, 0.45)',
    color: 'rgba(255,255,255,0.88)',
  },
};

const linkButtonSx = {
  color: brand.orange,
  fontSize: '1.125rem',
  fontWeight: 700,
};

const backButtonSx = {
  color: '#fff',
  fontSize: '1.125rem',
  fontWeight: 700,
  '&:hover': { color: brand.orange, bgcolor: 'rgba(255,255,255,0.06)' },
};

const alertSx = {
  mt: 2,
  '& .MuiAlert-message': { fontSize: '1.1rem', lineHeight: 1.45 },
};

const loginCardIn = keyframes`
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
`;

function LoginScreen() {
  const { login, register, isLoggingIn, loginError, authMessage } = useAuth();
  useDocumentTitle('Sign in');
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
  const location = useLocation();
  const nextPath = returnPath(location);
  const usernameRef = useRef(null);
  const companyRef = useRef(null);
  const registerAlertRef = useRef(null);
  const videoRef = useRef(null);
  const settledRef = useRef(false);
  const [videoNode, setVideoNode] = useState(null);
  const bindVideo = useCallback((node) => {
    videoRef.current = node;
    if (node) {
      node.muted = true;
      node.defaultMuted = true;
      node.playsInline = true;
      node.disableRemotePlayback = true;
    }
    setVideoNode(node);
  }, []);
  const prefersReducedMotion = useSyncExternalStore(subscribeToReducedMotion, reducedMotionSnapshot, () => false);
  const reducedRef = useRef(prefersReducedMotion);
  reducedRef.current = prefersReducedMotion;
  const [showVideo, setShowVideo] = useState(() => !shouldSkipIntro());
  const [holdPoster, setHoldPoster] = useState(false);
  const [introActive, setIntroActive] = useState(() => !shouldSkipIntro());
  const [formVisible, setFormVisible] = useState(() => shouldSkipIntro());
  const [animateForm, setAnimateForm] = useState(false);
  const revealFormRef = useRef(() => {});

  function revealForm({ animate, markSeen, keepVideo }) {
    if (settledRef.current) return;
    settledRef.current = true;
    if (markSeen) markIntroSeen();
    if (!keepVideo) {
      const video = videoRef.current;
      if (video) {
        try {
          video.pause();
        } catch (err) {
          // The element can already be gone.
        }
      }
      setShowVideo(false);
    }
    setHoldPoster(true);
    setIntroActive(false);
    if (animate && !reducedRef.current) {
      setAnimateForm(true);
    } else {
      setAnimateForm(false);
    }
    setFormVisible(true);
  }
  revealFormRef.current = revealForm;

  useEffect(() => {
    const previous = document.body.style.backgroundColor;
    document.body.style.backgroundColor = '#05070d';
    return () => {
      document.body.style.backgroundColor = previous;
    };
  }, []);

  useEffect(() => {
    if (!showVideo || !videoNode) return undefined;
    const video = videoNode;
    let cancelled = false;
    const fail = () => {
      if (cancelled || settledRef.current) return;
      revealFormRef.current({ animate: false, markSeen: false, keepVideo: false });
    };
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.addEventListener('error', fail);
    let pending;
    try {
      pending = video.play();
    } catch (err) {
      fail();
    }
    if (pending && typeof pending.catch === 'function') {
      pending.catch(() => {
        fail();
      });
    }
    return () => {
      cancelled = true;
      video.removeEventListener('error', fail);
    };
  }, [showVideo, videoNode]);

  useEffect(() => {
    if (!prefersReducedMotion || !showVideo || settledRef.current) return;
    revealFormRef.current({ animate: false, markSeen: false, keepVideo: false });
  }, [prefersReducedMotion, showVideo]);

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
    if (!formVisible) return;
    if (mode === 'sign-in') usernameRef.current?.focus();
    else companyRef.current?.focus();
  }, [mode, formVisible]);

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

    await login(username.trim(), password, nextPath);
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

  useEffect(() => {
    if (mode !== 'register' || !alertText) return;
    registerAlertRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [mode, alertText]);

  return (
    <Box
      component="main"
      sx={{
        minHeight: '100vh',
        boxSizing: 'border-box',
        colorScheme: 'dark',
        bgcolor: '#05070d',
        backgroundImage: 'radial-gradient(ellipse 90% 55% at 50% 12%, rgba(10, 47, 110, 0.55), rgba(5, 7, 13, 0) 68%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        px: { xs: 2, sm: 3 },
        pt: { xs: 6, sm: 5 },
        pb: 4,
        position: 'relative',
      }}
    >
      {introActive ? (
        <Button
          type="button"
          data-testid="intro-skip"
          onClick={() => revealForm({ animate: true, markSeen: true, keepVideo: false })}
          sx={{
            position: 'absolute',
            top: { xs: 8, sm: 16 },
            right: { xs: 8, sm: 16 },
            zIndex: 2,
            color: 'rgba(255,255,255,0.9)',
            textTransform: 'none',
            fontSize: '1rem',
            fontWeight: 600,
            minWidth: 0,
            px: 1.5,
            py: 0.5,
            '&:hover': { bgcolor: 'rgba(255,255,255,0.08)', color: '#fff' },
          }}
        >
          Skip
        </Button>
      ) : null}
      <Box
        data-testid="login-intro"
        sx={{
          width: 'min(100%, 640px, calc(40vh * 16 / 9))',
          maxWidth: '100%',
          aspectRatio: '16 / 9',
          position: 'relative',
          flexShrink: 0,
        }}
      >
        <Box
          component="img"
          src={INTRO_POSTER}
          alt="Launchpad"
          data-testid="login-intro-still"
          draggable={false}
          sx={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
            zIndex: 1,
            opacity: showVideo && !holdPoster ? 0 : 1,
          }}
        />
        {showVideo ? (
          <Box
            component="video"
            ref={bindVideo}
            data-testid="login-intro-video"
            src={INTRO_VIDEO}
            poster={INTRO_POSTER}
            muted
            autoPlay
            playsInline
            preload="auto"
            controls={false}
            disablePictureInPicture
            aria-hidden="true"
            tabIndex={-1}
            onEnded={() => revealForm({ animate: true, markSeen: true, keepVideo: true })}
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              display: 'block',
              zIndex: holdPoster ? 0 : 2,
              bgcolor: '#000',
              backgroundImage: `url(${INTRO_POSTER})`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'center',
              backgroundSize: 'contain',
              pointerEvents: 'none',
              '&::-webkit-media-controls': { display: 'none !important' },
              '&::-webkit-media-controls-enclosure': { display: 'none !important' },
            }}
          />
        ) : null}
      </Box>
      {formVisible ? (
        <Box
          data-testid="sign-in-card"
          sx={{
            width: { xs: '100%', sm: 520 },
            maxWidth: '100%',
            mt: { xs: 1, sm: 1.5 },
            bgcolor: 'rgba(10, 47, 110, 0.62)',
            borderRadius: 2,
            border: '1px solid rgba(245, 130, 32, 0.5)',
            boxShadow: '0 0 0 1px rgba(34, 211, 238, 0.35), inset 0 0 0 1px rgba(245, 130, 32, 0.28), 0 0 24px rgba(245, 130, 32, 0.2), 0 0 36px rgba(34, 211, 238, 0.14)',
            backdropFilter: 'blur(12px)',
            animation: animateForm ? `${loginCardIn} 500ms ease` : 'none',
            '@media (prefers-reduced-motion: reduce)': {
              animation: 'none',
            },
          }}
        >
          <Box sx={{ p: { xs: 2.5, sm: 4 } }}>
            {mode === 'sign-in' ? (
              <>
                <Typography variant="h5" sx={titleSx}>
                  Sign in
                </Typography>
                <Typography variant="body2" sx={subtitleSx}>
                  If you created an account here, sign in with your email.
                </Typography>
                <Box component="form" data-testid="sign-in-form" onSubmit={handleSubmit} sx={{ display: 'grid', gap: 2.5 }}>
                  <TextField
                    inputRef={usernameRef}
                    label="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    fullWidth
                    autoComplete="username"
                    variant="outlined"
                    sx={darkFieldSx}
                  />
                  <TextField
                    label="Password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    fullWidth
                    autoComplete="current-password"
                    variant="outlined"
                    sx={darkFieldSx}
                  />
                  <Button type="submit" variant="contained" size="large" fullWidth disabled={isLoggingIn} sx={loginButtonSx}>
                    {isLoggingIn ? <CircularProgress size={24} color="inherit" /> : 'Login'}
                  </Button>
                  {signupEnabled ? (
                    <Button type="button" data-testid="create-account-link" onClick={showRegister} sx={linkButtonSx}>
                      Create an account
                    </Button>
                  ) : null}
                </Box>
              </>
            ) : (
              <>
                <Typography variant="h5" sx={titleSx}>
                  Create an account
                </Typography>
                <Typography variant="body2" sx={subtitleSx}>
                  Your account is ready to use right away. Sign in later with this email.
                </Typography>
                <Box component="form" data-testid="register-form" onSubmit={handleRegister} sx={{ display: 'grid', gap: 2.5, position: 'relative' }}>
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
                    sx={darkFieldSx}
                  />
                  <TextField
                    label="Contact name"
                    value={contactName}
                    onChange={(event) => setContactName(event.target.value)}
                    fullWidth
                    autoComplete="name"
                    required
                    sx={darkFieldSx}
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
                    sx={darkFieldSx}
                  />
                  <TextField
                    label="Phone"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    fullWidth
                    autoComplete="tel"
                    required
                    sx={darkFieldSx}
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
                    sx={darkFieldSx}
                  />
                  <TextField
                    label="Confirm password"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    fullWidth
                    autoComplete="new-password"
                    required
                    sx={darkFieldSx}
                  />
                  {alertText ? (
                    <Box ref={registerAlertRef}>
                      <Alert severity="warning" sx={alertSx}>{alertText}</Alert>
                    </Box>
                  ) : null}
                  <Button type="submit" variant="contained" size="large" fullWidth disabled={isLoggingIn} sx={loginButtonSx}>
                    {isLoggingIn ? <CircularProgress size={24} color="inherit" /> : 'Create account'}
                  </Button>
                  <Button type="button" onClick={showSignIn} sx={backButtonSx}>
                    Back to sign in
                  </Button>
                </Box>
              </>
            )}
            {mode !== 'register' && alertText && (
              <Alert severity="warning" sx={alertSx}>
                {alertText}
              </Alert>
            )}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

function LoginGate() {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <LoginScreen />;
  const next = safeAppPath(new URLSearchParams(location.search).get('next'));
  if (next) return <Navigate to={next} replace />;
  return <Navigate to={user.role === 'customer' ? '/order' : '/'} replace />;
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
      <Route path="/login" element={<LoginGate />} />
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
        <Route path="send-files" element={<ProtectedRoute roles={['admin', 'operator', 'manager']}><SendFiles /></ProtectedRoute>} />
        <Route path="files" element={<ProtectedRoute roles={['admin', 'operator', 'manager', 'customer']}><CustomerFiles /></ProtectedRoute>} />
        <Route path="files/:id" element={<ProtectedRoute roles={['admin', 'operator', 'manager', 'customer']}><CustomerFiles /></ProtectedRoute>} />
        <Route path="search" element={<ProtectedRoute roles={['admin', 'operator', 'manager']}><SearchOrders /></ProtectedRoute>} />
        <Route path="send-proof" element={<ProtectedRoute roles={['admin', 'operator', 'manager']}><SendProofPage /></ProtectedRoute>} />
        <Route path="email-orders" element={<ProtectedRoute roles={['admin', 'operator', 'manager']}><EmailOrders /></ProtectedRoute>} />
        <Route path="email-orders/:id" element={<ProtectedRoute roles={['admin', 'operator', 'manager']}><EmailOrders /></ProtectedRoute>} />
        <Route path="proofs" element={<ProtectedRoute roles={['customer']}><CustomerProofsPage /></ProtectedRoute>} />
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
