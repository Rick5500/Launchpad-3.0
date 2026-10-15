import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { authFetch } from '../api';

function formatCreated(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString();
}

export default function Customers() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [issuedPassword, setIssuedPassword] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLoading(true);
    authFetch('/api/customers')
      .then((res) => {
        if (!res.ok) throw new Error('Unable to load customers.');
        return res.json();
      })
      .then((data) => setCustomers(data || []))
      .catch((err) => setError(err.message || 'Unable to load customers.'))
      .finally(() => setLoading(false));
  }, []);

  const closeDialog = () => {
    setSelected(null);
    setPassword('');
    setFormError('');
    setIssuedPassword('');
    setCopied(false);
    setSaving(false);
  };

  const openReset = (customer) => {
    setSelected(customer);
    setPassword('');
    setFormError('');
    setIssuedPassword('');
    setCopied(false);
  };

  const handleReset = async (event) => {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setFormError('');
    setCopied(false);

    const body = {};
    if (password.length > 0) body.password = password;

    try {
      const response = await authFetch(`/api/customers/${selected.id}/password`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to reset password');
      setIssuedPassword(payload.password || '');
      setPassword('');
    } catch (err) {
      setFormError(err.message || 'Failed to reset password');
    } finally {
      setSaving(false);
    }
  };

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(issuedPassword);
      setCopied(true);
    } catch {
      setCopied(false);
      setFormError('Unable to copy automatically. Select the password and copy it manually.');
    }
  };

  if (loading) return <LoadingState message="Loading customers..." />;
  if (error) return <ErrorState message={error} />;

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Customers
      </Typography>
      <Typography color="text.secondary" gutterBottom>
        Reset a customer password so an existing account can sign in. The new password is shown once.
      </Typography>
      <Card sx={{ bgcolor: '#ffffff', mt: 2 }}>
        <CardContent>
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Username</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell align="right">Password</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {customers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
                      No customers found.
                    </TableCell>
                  </TableRow>
                ) : (
                  customers.map((customer) => (
                    <TableRow key={customer.id} hover sx={{ '&:hover': { bgcolor: '#f0f4fa' } }}>
                      <TableCell>{customer.display_name || '-'}</TableCell>
                      <TableCell>{customer.username}</TableCell>
                      <TableCell>{formatCreated(customer.created_at)}</TableCell>
                      <TableCell align="right">
                        <Button variant="outlined" size="small" onClick={() => openReset(customer)}>
                          Reset password
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      <Dialog open={Boolean(selected)} onClose={closeDialog} fullWidth maxWidth="sm">
        <DialogTitle>
          {issuedPassword ? 'Password reset' : `Reset password for ${selected?.display_name || selected?.username || 'customer'}`}
        </DialogTitle>
        {issuedPassword ? (
          <>
            <DialogContent sx={{ display: 'grid', gap: 2 }}>
              <Alert severity="info">
                This password is shown once and will not be shown again. Copy it now. {selected?.username} will need to sign in again.
              </Alert>
              <TextField
                label="New password"
                value={issuedPassword}
                fullWidth
                variant="filled"
                InputProps={{ readOnly: true, sx: { bgcolor: '#ffffff' } }}
              />
              {formError && <Alert severity="warning">{formError}</Alert>}
            </DialogContent>
            <DialogActions>
              <Button onClick={copyPassword}>{copied ? 'Copied' : 'Copy'}</Button>
              <Button variant="contained" onClick={closeDialog}>Done</Button>
            </DialogActions>
          </>
        ) : (
          <Box component="form" onSubmit={handleReset}>
            <DialogContent sx={{ display: 'grid', gap: 2 }}>
              {formError && <Alert severity="error">{formError}</Alert>}
              <TextField
                label="New password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                fullWidth
                autoFocus
                autoComplete="new-password"
                variant="filled"
                helperText="Leave blank to generate a random password. A typed password must be at least 8 characters."
                InputProps={{ sx: { bgcolor: '#ffffff' } }}
              />
            </DialogContent>
            <DialogActions>
              <Button onClick={closeDialog} disabled={saving}>Cancel</Button>
              <Button type="submit" variant="contained" disabled={saving}>
                {saving ? 'Saving…' : 'Reset password'}
              </Button>
            </DialogActions>
          </Box>
        )}
      </Dialog>
    </Box>
  );
}
