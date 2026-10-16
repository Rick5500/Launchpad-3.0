import React, { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
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
import { authFetch } from '../api';

const emptyForm = {
  location: '',
  department_name: '',
  stage_name: '',
  sort_order: '0',
  is_active: true,
};

export default function BarcodeSettingsPage() {
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [stages, setStages] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scanValue, setScanValue] = useState('');
  const [scanLocation, setScanLocation] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');

  function load() {
    setLoading(true);
    authFetch('/api/barcode/locations')
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load locations');
        setLocations(body.locations || []);
      })
      .catch((err) => setError(err.message || 'Unable to load locations'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    authFetch('/api/departments').then((response) => (response.ok ? response.json() : [])).then((rows) => setDepartments(Array.isArray(rows) ? rows : [])).catch(() => {});
    authFetch('/api/production-stages').then((response) => (response.ok ? response.json() : [])).then((rows) => setStages(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, []);

  function edit(row) {
    setEditingId(row.id);
    setForm({
      location: row.location || '',
      department_name: row.department_name || '',
      stage_name: row.stage_name || '',
      sort_order: String(row.sort_order ?? 0),
      is_active: Boolean(row.is_active),
    });
  }

  async function save(event) {
    event.preventDefault();
    setError('');
    setNotice('');
    const payload = {
      ...form,
      department_name: form.department_name || null,
      stage_name: form.stage_name || null,
      sort_order: Number(form.sort_order || 0),
    };
    const response = await authFetch(editingId ? `/api/barcode/locations/${editingId}` : '/api/barcode/locations', {
      method: editingId ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error || 'Unable to save location');
      return;
    }
    setForm(emptyForm);
    setEditingId(null);
    setNotice('Location saved. The scan endpoint uses this list.');
    load();
  }

  async function remove(row) {
    setError('');
    const response = await authFetch(`/api/barcode/locations/${row.id}`, { method: 'DELETE' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error || 'Unable to remove location');
      return;
    }
    if (editingId === row.id) {
      setEditingId(null);
      setForm(emptyForm);
    }
    load();
  }

  async function dryRun(event) {
    event.preventDefault();
    setPreview(null);
    setPreviewError('');
    const response = await authFetch('/api/barcode/dry-run', {
      method: 'POST',
      body: JSON.stringify({
        scanned_value: scanValue,
        location: scanLocation.trim() || null,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setPreviewError(body.error || 'Unable to resolve scan');
      return;
    }
    setPreview(body);
  }

  const departmentOptions = departments.filter((row) => row.is_active !== 0).map((row) => row.name);

  return (
    <Box data-testid="barcode-settings-page">
      <Typography variant="h4" gutterBottom>Barcode Settings</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Each location can move a work order into a department, advance a production stage, or both. The test below does not record a scan.
      </Typography>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert> : null}

      <SectionCard title={editingId ? 'Edit location' : 'Add location'}>
        <Box component="form" onSubmit={save} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
          <TextField label="Location" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} required />
          <TextField select label="Department" value={form.department_name} onChange={(event) => setForm({ ...form, department_name: event.target.value })}>
            <MenuItem value="">None</MenuItem>
            {departmentOptions.map((name) => <MenuItem key={name} value={name}>{name}</MenuItem>)}
          </TextField>
          <TextField select label="Stage" value={form.stage_name} onChange={(event) => setForm({ ...form, stage_name: event.target.value })}>
            <MenuItem value="">None</MenuItem>
            {stages.map((stage) => <MenuItem key={stage.id} value={stage.name}>{stage.name}</MenuItem>)}
          </TextField>
          <TextField label="Sort order" type="number" value={form.sort_order} onChange={(event) => setForm({ ...form, sort_order: event.target.value })} />
          <FormControlLabel control={<Switch checked={form.is_active} onChange={(event) => setForm({ ...form, is_active: event.target.checked })} />} label="Active" />
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button type="submit" variant="contained">{editingId ? 'Save location' : 'Add location'}</Button>
            {editingId ? <Button onClick={() => { setEditingId(null); setForm(emptyForm); }}>Cancel</Button> : null}
          </Box>
        </Box>
      </SectionCard>

      <SectionCard title="Locations">
        {loading ? <LoadingState message="Loading locations..." /> : null}
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Location</TableCell>
                <TableCell>Department</TableCell>
                <TableCell>Stage</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {locations.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.location}</TableCell>
                  <TableCell>{row.department_name || '—'}</TableCell>
                  <TableCell>{row.stage_name || '—'}</TableCell>
                  <TableCell><Chip size="small" label={row.is_active ? 'Active' : 'Inactive'} color={row.is_active ? 'success' : 'default'} /></TableCell>
                  <TableCell>
                    <Button size="small" onClick={() => edit(row)}>Edit</Button>
                    <Button size="small" color="error" onClick={() => remove(row)}>Remove</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </SectionCard>

      <SectionCard title="Test a scan" subtitle="Dry run. Nothing is written to the scan log, the work order, or the activity log.">
        <Box component="form" onSubmit={dryRun} sx={{ display: 'grid', gap: 2, maxWidth: 640 }}>
          <TextField label="Scan value" value={scanValue} onChange={(event) => setScanValue(event.target.value)} required helperText="Work order number, for example 20260609-041-A." />
          <TextField label="Location" value={scanLocation} onChange={(event) => setScanLocation(event.target.value)} helperText="Optional station name from the table above." />
          <Box>
            <Button type="submit" variant="contained">Resolve</Button>
          </Box>
        </Box>
        {previewError ? <Alert severity="error" sx={{ mt: 2 }}>{previewError}</Alert> : null}
        {preview ? (
          <Box sx={{ mt: 2 }} data-testid="barcode-dry-run-result">
            <Typography sx={{ mb: 1 }}>
              {preview.work_order
                ? `Work order ${preview.work_order.external_id || preview.work_order.id} in ${preview.work_order.department || 'unassigned'}.`
                : 'No work order matches that scan value.'}
            </Typography>
            <Typography sx={{ mb: 1 }}>
              Location {preview.location?.matched ? 'matches' : 'does not match'} the saved map
              {preview.location?.department_name ? ` · department ${preview.location.department_name}` : ''}
              {preview.location?.stage_name ? ` · stage ${preview.location.stage_name}` : ''}.
              {preview.location?.would_move_department ? ' This would move the work order.' : ' This would not move the department.'}
              {preview.location?.would_advance_stage ? ' This would advance the stage.' : ''}
              {preview.location?.would_complete ? ' This would mark the work order completed.' : ''}
            </Typography>
            {preview.work_order?.print_path ? (
              <Button component={RouterLink} to={preview.work_order.print_path} variant="outlined">
                Open printable work order
              </Button>
            ) : (
              <Typography color="text.secondary">Resolve a work order to open its printable view.</Typography>
            )}
          </Box>
        ) : null}
      </SectionCard>
    </Box>
  );
}
