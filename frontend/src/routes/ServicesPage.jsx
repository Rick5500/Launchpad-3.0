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

const emptyForm = {
  name: '',
  code: '',
  suffix_mode: 'sequence',
  department_name: '',
  description: '',
  sort_order: '0',
  default_turnaround_hours: '',
  requires_approval: false,
  is_active: true,
};

export default function ServicesPage() {
  const [services, setServices] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [departments, setDepartments] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const limit = 20;

  function load(nextOffset = offset) {
    setLoading(true);
    authFetch(`/api/services?limit=${limit}&offset=${nextOffset}&sort=sort_order&dir=asc`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load services');
        setServices(body.services || []);
        setTotal(body.total || 0);
        setError('');
      })
      .catch((err) => setError(err.message || 'Unable to load services'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load(offset);
  }, [offset]);

  useEffect(() => {
    authFetch('/api/departments')
      .then((response) => (response.ok ? response.json() : []))
      .then((rows) => setDepartments(Array.isArray(rows) ? rows : []))
      .catch(() => setDepartments([]));
  }, []);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function edit(service) {
    setEditingId(service.id);
    setForm({
      name: service.name || '',
      code: service.code || '',
      suffix_mode: service.suffix_mode || 'sequence',
      department_name: service.department_name || '',
      description: service.description || '',
      sort_order: String(service.sort_order ?? 0),
      default_turnaround_hours: service.default_turnaround_hours == null ? '' : String(service.default_turnaround_hours),
      requires_approval: Boolean(service.requires_approval),
      is_active: Boolean(service.is_active),
    });
    setNotice('');
    setError('');
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    const payload = {
      ...form,
      sort_order: form.sort_order === '' ? 0 : Number(form.sort_order),
      default_turnaround_hours: form.default_turnaround_hours === '' ? null : Number(form.default_turnaround_hours),
    };
    try {
      const response = await authFetch(editingId ? `/api/services/${editingId}` : '/api/services', {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to save service');
      setForm(emptyForm);
      setEditingId(null);
      setNotice(editingId ? 'Service updated.' : 'Service created.');
      load(offset);
    } catch (err) {
      setError(err.message || 'Unable to save service');
    } finally {
      setSaving(false);
    }
  }

  async function setActive(service, isActive) {
    setError('');
    const response = await authFetch(`/api/services/${service.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: service.name,
        code: service.code,
        suffix_mode: service.suffix_mode || 'sequence',
        department_name: service.department_name,
        description: service.description || '',
        sort_order: service.sort_order || 0,
        default_turnaround_hours: service.default_turnaround_hours,
        requires_approval: Boolean(service.requires_approval),
        is_active: isActive,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error || 'Unable to update service');
      return;
    }
    load(offset);
  }

  const departmentNames = departments.filter((row) => row.is_active !== 0).map((row) => row.name);
  if (form.department_name && !departmentNames.includes(form.department_name)) {
    departmentNames.push(form.department_name);
  }

  return (
    <Box data-testid="services-page">
      <Typography variant="h4" gutterBottom>Services</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Deactivated services leave the customer order form. Orders already created keep their work orders.
      </Typography>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert> : null}

      <SectionCard title={editingId ? 'Edit service' : 'New service'}>
        <Box component="form" onSubmit={save} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
          <TextField label="Name" value={form.name} onChange={(event) => update('name', event.target.value)} required />
          <TextField label="Code" value={form.code} onChange={(event) => update('code', event.target.value)} required helperText="Letters and digits. Used as the work order suffix when suffix mode is code." />
          <TextField select label="Suffix mode" value={form.suffix_mode} onChange={(event) => update('suffix_mode', event.target.value)}>
            <MenuItem value="sequence">Sequence (A, B, C by sort order)</MenuItem>
            <MenuItem value="code">Service code</MenuItem>
          </TextField>
          <TextField select label="Department" value={form.department_name} onChange={(event) => update('department_name', event.target.value)} required>
            {departmentNames.map((name) => <MenuItem key={name} value={name}>{name}</MenuItem>)}
          </TextField>
          <TextField label="Description" value={form.description} onChange={(event) => update('description', event.target.value)} />
          <TextField label="Sort order" type="number" value={form.sort_order} onChange={(event) => update('sort_order', event.target.value)} />
          <TextField label="Default turnaround (hours)" type="number" value={form.default_turnaround_hours} onChange={(event) => update('default_turnaround_hours', event.target.value)} helperText="Optional. Shown on the order form. It does not change the due date." />
          <Box>
            <FormControlLabel control={<Switch checked={form.requires_approval} onChange={(event) => update('requires_approval', event.target.checked)} />} label="Requires approval" />
            <FormControlLabel control={<Switch checked={form.is_active} onChange={(event) => update('is_active', event.target.checked)} />} label="Active" />
          </Box>
          <Box sx={{ display: 'flex', gap: 1, gridColumn: '1 / -1' }}>
            <Button type="submit" variant="contained" disabled={saving}>{saving ? 'Saving...' : editingId ? 'Save changes' : 'Create service'}</Button>
            {editingId ? <Button onClick={() => { setEditingId(null); setForm(emptyForm); }}>Cancel</Button> : null}
          </Box>
        </Box>
      </SectionCard>

      <SectionCard title="Service list">
        {loading ? <LoadingState message="Loading services..." /> : null}
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Code</TableCell>
                <TableCell>Suffix</TableCell>
                <TableCell>Department</TableCell>
                <TableCell>Turnaround</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {services.map((service) => (
                <TableRow key={service.id}>
                  <TableCell>{service.name}</TableCell>
                  <TableCell>{service.code}</TableCell>
                  <TableCell>{service.suffix_mode === 'code' ? 'Code' : 'A/B/C'}</TableCell>
                  <TableCell>{service.department_name}</TableCell>
                  <TableCell>{service.default_turnaround_hours ? `${service.default_turnaround_hours} h` : '—'}</TableCell>
                  <TableCell>
                    <Chip size="small" label={service.is_active ? 'Active' : 'Inactive'} color={service.is_active ? 'success' : 'default'} />
                  </TableCell>
                  <TableCell>
                    <Button size="small" onClick={() => edit(service)}>Edit</Button>
                    <Button size="small" onClick={() => setActive(service, !service.is_active)}>
                      {service.is_active ? 'Deactivate' : 'Reactivate'}
                    </Button>
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
