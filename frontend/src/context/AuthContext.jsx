import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clearStoredAuth } from '../api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [authMessage, setAuthMessage] = useState(() => {
    const storedMessage = sessionStorage.getItem('auth_message');
    if (storedMessage) {
      sessionStorage.removeItem('auth_message');
      return storedMessage;
    }
    return '';
  });

  const clearSession = useCallback(
    (message = 'Your session has expired. Please log in again.', redirect = true) => {
      clearStoredAuth(message);
      setUser(null);
      setIsAuthenticated(false);
      setLoginError('');
      setAuthMessage(message);
      if (redirect) {
        navigate('/login', { replace: true });
      }
    },
    [navigate],
  );

  const refreshUser = useCallback(async () => {
    const token = localStorage.getItem('lp_token');
    if (!token) {
      setUser(null);
      setIsAuthenticated(false);
      setIsLoading(false);
      return null;
    }

    try {
      const response = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error('invalid-token');
      }

      const data = await response.json();
      if (data?.user) {
        setUser(data.user);
        setIsAuthenticated(true);
        setLoginError('');
        setIsLoading(false);
        return data.user;
      }

      throw new Error('invalid-token');
    } catch {
      clearSession('Your session has expired. Please log in again.', false);
      setIsLoading(false);
      return null;
    }
  }, [clearSession]);

  useEffect(() => {
    const handleExpired = (event) => {
      const message = event?.detail?.message || 'Your session has expired. Please log in again.';
      clearSession(message);
    };

    window.addEventListener('auth:expired', handleExpired);
    return () => window.removeEventListener('auth:expired', handleExpired);
  }, [clearSession]);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const login = useCallback(
    async (username, password) => {
      setIsLoggingIn(true);
      setLoginError('');
      setAuthMessage('');

      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const payload = await response.json();

        if (!response.ok || !payload?.token) {
          setUser(null);
          setIsAuthenticated(false);
          setLoginError(payload?.error || 'Login failed. Please check your credentials.');
          return false;
        }

        localStorage.setItem('lp_token', payload.token);
        setUser(payload.user);
        setIsAuthenticated(true);
        setLoginError('');
        setAuthMessage('');
        navigate(payload.user?.role === 'customer' ? '/order' : '/', { replace: true });
        return true;
      } catch {
        setUser(null);
        setIsAuthenticated(false);
        setLoginError('Network error. Please try again.');
        return false;
      } finally {
        setIsLoggingIn(false);
      }
    },
    [navigate],
  );

  const register = useCallback(
    async (payload) => {
      setIsLoggingIn(true);
      setLoginError('');
      setAuthMessage('');

      try {
        const response = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body?.token) {
          setUser(null);
          setIsAuthenticated(false);
          setLoginError(body?.error || 'Unable to create an account.');
          return false;
        }

        localStorage.setItem('lp_token', body.token);
        setUser(body.user);
        setIsAuthenticated(true);
        setLoginError('');
        setAuthMessage('');
        navigate('/order', { replace: true });
        return true;
      } catch {
        setUser(null);
        setIsAuthenticated(false);
        setLoginError('Network error. Please try again.');
        return false;
      } finally {
        setIsLoggingIn(false);
      }
    },
    [navigate],
  );

  const logout = useCallback(() => {
    const token = localStorage.getItem('lp_token');
    if (token) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    clearStoredAuth('');
    setUser(null);
    setIsAuthenticated(false);
    setLoginError('');
    setAuthMessage('');
    navigate('/login', { replace: true });
  }, [navigate]);

  const value = useMemo(
    () => ({
      user,
      isAuthenticated,
      isLoading,
      isLoggingIn,
      loginError,
      authMessage,
      login,
      register,
      logout,
      refreshUser,
    }),
    [user, isAuthenticated, isLoading, isLoggingIn, loginError, authMessage, login, register, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
