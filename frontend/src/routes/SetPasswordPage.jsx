import React, { useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, TextField, Typography } from '@mui/material';
import { brand } from '../brand';
import { useDocumentTitle } from '../useDocumentTitle';

export default function SetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);
  useDocumentTitle('Set your password');

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (!token) {
      setError('This link is invalid or has expired. Ask your shop to send a new one.');
      return;
    }
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Password and confirmation do not match.');
      return;
    }
    setSaving(true);
    try {
      const response = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, password_confirm: confirmPassword }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to set the password');
      setDone(true);
    } catch (err) {
      setError(err.message || 'Unable to set the password');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: brand.navy, display: 'flex', alignItems: 'center', justifyContent: 'center', px: 2, py: 4 }}>
      <Box
        component="form"
        onSubmit={submit}
        data-testid="set-password-page"
        sx={{
          width: '100%',
          maxWidth: 520,
          bgcolor: '#fff',
          borderRadius: 2,
          p: { xs: 3, sm: 4 },
          borderTop: `6px solid ${brand.orange}`,
        }}
      >
        <Typography variant="h4" sx={{ color: brand.navy, fontWeight: 700, mb: 1, fontSize: { xs: '1.75rem', sm: '2rem' } }}>
          Set your password
        </Typography>
        <Typography sx={{ color: brand.text, fontSize: '1.125rem', lineHeight: 1.5, mb: 3 }}>
          Choose a password for your Launchpad account. You will use it the next time you sign in.
        </Typography>
        {done ? (
          <Alert severity="success" sx={{ fontSize: '1.05rem' }}>
            Your password is saved. <RouterLink to="/login">Sign in</RouterLink>
          </Alert>
        ) : (
          <>
            {error ? <Alert severity="error" sx={{ mb: 2, fontSize: '1.05rem' }}>{error}</Alert> : null}
            <TextField
              label="New password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              required
              fullWidth
              sx={{ mb: 2 }}
              inputProps={{ style: { fontSize: '1.125rem' } }}
            />
            <TextField
              label="Confirm password"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              required
              fullWidth
              sx={{ mb: 3 }}
              inputProps={{ style: { fontSize: '1.125rem' } }}
            />
            <Button type="submit" variant="contained" disabled={saving} size="large" sx={{ bgcolor: brand.orange, color: '#111', fontWeight: 700, fontSize: '1.05rem', '&:hover': { bgcolor: brand.orangeDark } }}>
              {saving ? 'Saving...' : 'Save password'}
            </Button>
          </>
        )}
      </Box>
    </Box>
  );
}
