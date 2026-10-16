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
  const [addressCustomer, setAddressCustomer] = useState(null);
  const [addressForm, setAddressForm] = useState({
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    zip: '',
  });
  const [addressError, setAddressError] = useState('');
  const [addressSaving, setAddressSaving] = useState(false);
  const [addressNotice, setAddressNotice] = useState('');

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

  const openAddress = (customer) => {
    setAddressCustomer(customer);
    setAddressForm({
      address_line1: customer.address_line1 || '',
      address_line2: customer.address_line2 || '',
      city: customer.city || '',
      state: customer.state || '',
      zip: customer.zip || '',
    });
    setAddressError('');
    setAddressNotice('');
  };

  const saveAddress = async (event) => {
    event.preventDefault();
    if (!addressCustomer) return;
    setAddressSaving(true);
    setAddressError('');
    setAddressNotice('');
    try {
      const response = await authFetch(`/api/customers/${addressCustomer.id}`, {
        method: 'PUT',
        body: JSON.stringify(addressForm),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to update address');
      setCustomers((rows) => rows.map((row) => (row.id === payload.id ? { ...row, ...payload } : row)));
      setAddressNotice('Address saved. New orders prefill this address. Orders already submitted keep the address they were given.');
      setAddressCustomer((current) => (current ? { ...current, ...payload } : current));
    } catch (err) {
      setAddressError(err.message || 'Failed to update address');
    } finally {
      setAddressSaving(false);
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
                  <TableCell>Address</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {customers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
                      No customers found.
                    </TableCell>
                  </TableRow>
                ) : (
                  customers.map((customer) => (
                    <TableRow key={customer.id} hover sx={{ '&:hover': { bgcolor: '#f0f4fa' } }}>
                      <TableCell>{customer.display_name || '-'}</TableCell>
                      <TableCell>{customer.username}</TableCell>
                      <TableCell>{formatCreated(customer.created_at)}</TableCell>
                      <TableCell>
                        {[customer.address_line1, customer.city, customer.state, customer.zip].filter(Boolean).join(', ') || '—'}
                      </TableCell>
                      <TableCell align="right">
                        <Button variant="outlined" size="small" onClick={() => openAddress(customer)} sx={{ mr: 1 }}>
                          Edit address
                        </Button>
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

      <Dialog open={Boolean(addressCustomer)} onClose={() => setAddressCustomer(null)} fullWidth maxWidth="sm">
        <Box component="form" onSubmit={saveAddress}>
          <DialogTitle>Company address for {addressCustomer?.display_name || addressCustomer?.username}</DialogTitle>
          <DialogContent sx={{ display: 'grid', gap: 2 }}>
            <Typography color="text.secondary">
              This address prefills the customer order form. Submitting an order stores a copy on that order and does not change older orders.
            </Typography>
            {addressError && <Alert severity="error">{addressError}</Alert>}
            {addressNotice && <Alert severity="success">{addressNotice}</Alert>}
            <TextField label="Addr 1" value={addressForm.address_line1} onChange={(event) => setAddressForm({ ...addressForm, address_line1: event.target.value })} fullWidth />
            <TextField label="Addr 2" value={addressForm.address_line2} onChange={(event) => setAddressForm({ ...addressForm, address_line2: event.target.value })} fullWidth />
            <TextField label="City" value={addressForm.city} onChange={(event) => setAddressForm({ ...addressForm, city: event.target.value })} fullWidth />
            <TextField label="State" value={addressForm.state} onChange={(event) => setAddressForm({ ...addressForm, state: event.target.value })} fullWidth />
            <TextField label="Zip" value={addressForm.zip} onChange={(event) => setAddressForm({ ...addressForm, zip: event.target.value })} fullWidth />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setAddressCustomer(null)} disabled={addressSaving}>Close</Button>
            <Button type="submit" variant="contained" disabled={addressSaving}>{addressSaving ? 'Saving...' : 'Save address'}</Button>
          </DialogActions>
        </Box>
      </Dialog>

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
