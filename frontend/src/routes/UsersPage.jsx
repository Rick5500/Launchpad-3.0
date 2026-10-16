import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  MenuItem,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import SectionCard from '../components/SectionCard';
import LoadingState from '../components/LoadingState';
import Pager from '../components/Pager';
import { authFetch } from '../api';
import { useAuth } from '../context/AuthContext';

const emptyForm = {
  username: '',
  display_name: '',
  role: 'operator',
  company: '',
  contact_name: '',
  phone: '',
  email: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  zip: '',
  department: '',
  password: '',
  is_active: true,
};

export default function UsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [applied, setApplied] = useState({ q: '', role: '' });
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [issuedPassword, setIssuedPassword] = useState('');
  const [departments, setDepartments] = useState([]);
  const limit = 20;

  useEffect(() => {
    authFetch('/api/departments')
      .then(async (response) => {
        const body = await response.json().catch(() => []);
        if (!response.ok || !Array.isArray(body)) return;
        setDepartments(body.map((row) => row.name).filter(Boolean));
      })
      .catch(() => {});
  }, []);

  function load(nextOffset = offset, filters = applied) {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(limit), offset: String(nextOffset), sort: 'username', dir: 'asc' });
    if (filters.q) params.set('q', filters.q);
    if (filters.role) params.set('role', filters.role);
    authFetch(`/api/users?${params.toString()}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load users');
        setUsers(body.users || []);
        setTotal(body.total || 0);
      })
      .catch((err) => setError(err.message || 'Unable to load users'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load(offset, applied);
  }, [offset, applied]);

  function update(field, value) {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'role' && value === 'customer') next.department = '';
      return next;
    });
  }

  function edit(row) {
    setEditingId(row.id);
    setForm({
      username: row.username || '',
      display_name: row.display_name || '',
      role: row.role || 'customer',
      company: row.company || '',
      contact_name: row.contact_name || '',
      phone: row.phone || '',
      email: row.email || '',
      address_line1: row.address_line1 || '',
      address_line2: row.address_line2 || '',
      city: row.city || '',
      state: row.state || '',
      zip: row.zip || '',
      department: row.department || '',
      password: '',
      is_active: Boolean(row.is_active),
    });
    setIssuedPassword('');
    setNotice('');
    setError('');
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    setIssuedPassword('');
    const payload = {
      username: form.username,
      display_name: form.display_name,
      role: form.role,
      company: form.company,
      contact_name: form.contact_name,
      phone: form.phone,
      email: form.email,
      address_line1: form.address_line1,
      address_line2: form.address_line2,
      city: form.city,
      state: form.state,
      zip: form.zip,
      department: form.role === 'customer' ? null : (form.department || null),
      is_active: form.is_active,
    };
    if (!editingId && form.password) payload.password = form.password;
    try {
      const response = await authFetch(editingId ? `/api/users/${editingId}` : '/api/users', {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to save user');
      if (body.password) setIssuedPassword(body.password);
      setNotice(editingId ? 'User updated.' : 'User created.');
      setForm(emptyForm);
      setEditingId(null);
      load(offset, applied);
    } catch (err) {
      setError(err.message || 'Unable to save user');
    } finally {
      setSaving(false);
    }
  }

  async function resetPassword(row) {
    setError('');
    setIssuedPassword('');
    const response = await authFetch(`/api/users/${row.id}/password`, { method: 'PUT', body: JSON.stringify({}) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error || 'Unable to reset password');
      return;
    }
    setIssuedPassword(body.password || '');
    setNotice(`Password reset for ${body.username}. Copy it now. It is not stored in a readable form.`);
  }

  return (
    <Box data-testid="users-page">
      <Typography variant="h4" gutterBottom>Users</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Staff and customer accounts. Password hashes are never shown. You cannot demote or deactivate your own account, or the last active administrator.
      </Typography>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert> : null}
      {issuedPassword ? (
        <Alert severity="warning" sx={{ mb: 2 }}>
          One-time password: <strong>{issuedPassword}</strong>
        </Alert>
      ) : null}

      <SectionCard title={editingId ? 'Edit user' : 'New user'}>
        <Box component="form" onSubmit={save} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
          <TextField label="Username" value={form.username} onChange={(event) => update('username', event.target.value)} required />
          <TextField label="Display name" value={form.display_name} onChange={(event) => update('display_name', event.target.value)} required />
          <TextField select label="Role" value={form.role} onChange={(event) => update('role', event.target.value)}>
            <MenuItem value="admin">Admin</MenuItem>
            <MenuItem value="operator">Operator</MenuItem>
            <MenuItem value="customer">Customer</MenuItem>
          </TextField>
          {form.role === 'admin' || form.role === 'operator' ? (
            <TextField
              select
              label="Department"
              value={form.department}
              onChange={(event) => update('department', event.target.value)}
              helperText="All departments shows every active work order."
            >
              <MenuItem value="">All departments</MenuItem>
              {(form.department && !departments.includes(form.department) ? [form.department, ...departments] : departments).map((name) => (
                <MenuItem key={name} value={name}>{name}</MenuItem>
              ))}
            </TextField>
          ) : null}
          <TextField label="Company" value={form.company} onChange={(event) => update('company', event.target.value)} />
          <TextField label="Contact name" value={form.contact_name} onChange={(event) => update('contact_name', event.target.value)} />
          <TextField label="Phone" value={form.phone} onChange={(event) => update('phone', event.target.value)} />
          <TextField label="Email" value={form.email} onChange={(event) => update('email', event.target.value)} />
          <TextField label="Addr 1" value={form.address_line1} onChange={(event) => update('address_line1', event.target.value)} />
          <TextField label="Addr 2" value={form.address_line2} onChange={(event) => update('address_line2', event.target.value)} />
          <TextField label="City" value={form.city} onChange={(event) => update('city', event.target.value)} />
          <TextField label="State" value={form.state} onChange={(event) => update('state', event.target.value)} />
          <TextField label="Zip" value={form.zip} onChange={(event) => update('zip', event.target.value)} />
          {!editingId ? (
            <TextField label="Password" type="password" value={form.password} onChange={(event) => update('password', event.target.value)} helperText="Leave blank to generate a one-time password." />
          ) : null}
          <FormControlLabel control={<Switch checked={form.is_active} onChange={(event) => update('is_active', event.target.checked)} />} label="Active" />
          <Box sx={{ display: 'flex', gap: 1, gridColumn: '1 / -1' }}>
            <Button type="submit" variant="contained" disabled={saving}>{saving ? 'Saving...' : editingId ? 'Save changes' : 'Create user'}</Button>
            {editingId ? <Button onClick={() => { setEditingId(null); setForm(emptyForm); }}>Cancel</Button> : null}
          </Box>
        </Box>
      </SectionCard>

      <SectionCard title="Directory">
        <Box component="form" onSubmit={(event) => { event.preventDefault(); setOffset(0); setApplied({ q, role }); }} sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 2 }}>
          <TextField label="Search" value={q} onChange={(event) => setQ(event.target.value)} />
          <TextField select label="Role" value={role} onChange={(event) => setRole(event.target.value)} sx={{ minWidth: 160 }}>
            <MenuItem value="">All roles</MenuItem>
            <MenuItem value="admin">Admin</MenuItem>
            <MenuItem value="operator">Operator</MenuItem>
            <MenuItem value="customer">Customer</MenuItem>
          </TextField>
          <Button type="submit" variant="outlined">Filter</Button>
        </Box>
        {loading ? <LoadingState message="Loading users..." /> : null}
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Username</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Department</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {users.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.username}{row.id === user?.id ? ' (you)' : ''}</TableCell>
                  <TableCell>{row.display_name}</TableCell>
                  <TableCell>{row.role}</TableCell>
                  <TableCell>{row.role === 'customer' ? '—' : (row.department || 'All departments')}</TableCell>
                  <TableCell>{row.email || '—'}</TableCell>
                  <TableCell><Chip size="small" label={row.is_active ? 'Active' : 'Inactive'} color={row.is_active ? 'success' : 'default'} /></TableCell>
                  <TableCell>
                    <Button size="small" onClick={() => edit(row)}>Edit</Button>
                    <Button size="small" onClick={() => resetPassword(row)}>Reset password</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <Pager offset={offset} limit={limit} total={total} onChange={setOffset} />
      </SectionCard>
    </Box>
  );
}
