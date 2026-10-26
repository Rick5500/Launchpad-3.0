import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  MenuItem,
  Switch,
  FormControlLabel,
  TextField,
  Typography,
} from '@mui/material';
import SectionCard from '../components/SectionCard';
import LoadingState from '../components/LoadingState';
import { authFetch } from '../api';
import { brand } from '../brand';

const emptyForm = {
  name: '',
  address: '',
  phone: '',
  is_active: true,
  sort_order: '',
};

const fieldSx = {
  '& .MuiInputBase-input': { fontSize: '1.15rem' },
  '& .MuiInputLabel-root': { fontSize: '1.05rem' },
};

export default function LocationsPage() {
  const [locations, setLocations] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function load() {
    setLoading(true);
    authFetch('/api/locations?all=1')
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
  }, []);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function edit(row) {
    setEditingId(row.id);
    setForm({
      name: row.name || '',
      address: row.address || '',
      phone: row.phone || '',
      is_active: Boolean(row.is_active),
      sort_order: row.sort_order == null ? '' : String(row.sort_order),
    });
    setError('');
    setNotice('');
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    const payload = {
      name: form.name,
      address: form.address,
      phone: form.phone,
      is_active: form.is_active,
    };
    if (form.sort_order !== '') payload.sort_order = Number(form.sort_order);
    try {
      const response = await authFetch(editingId ? `/api/locations/${editingId}` : '/api/locations', {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to save the location');
      setNotice(editingId ? 'Location updated.' : 'Location added.');
      setForm(emptyForm);
      setEditingId(null);
      load();
    } catch (err) {
      setError(err.message || 'Unable to save the location');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Box data-testid="locations-page">
      <Typography variant="h4" sx={{ color: brand.navy, fontWeight: 800, fontSize: { xs: '2rem', sm: '2.25rem' } }} gutterBottom>
        Locations
      </Typography>
      <Typography sx={{ color: brand.muted, fontSize: '1.15rem', mb: 2, maxWidth: 760 }}>
        Raleigh, Hickory, and Charlotte are the shops. Each order belongs to one location. Turn a shop off when it should not accept new work. At least one location stays active.
      </Typography>
      {error ? <Alert severity="error" sx={{ mb: 2, '& .MuiAlert-message': { fontSize: '1.1rem' } }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" sx={{ mb: 2, '& .MuiAlert-message': { fontSize: '1.1rem' } }}>{notice}</Alert> : null}

      <SectionCard title={editingId ? 'Edit location' : 'Add location'}>
        <Box component="form" onSubmit={save} sx={{ display: 'grid', gap: 2, maxWidth: 720 }}>
          <TextField label="Name" required value={form.name} onChange={(event) => update('name', event.target.value)} sx={fieldSx} />
          <TextField
            label="Address"
            required
            multiline
            minRows={3}
            value={form.address}
            onChange={(event) => update('address', event.target.value)}
            helperText="Street on the first line, city and state on the next. This prints on work orders and emails."
            sx={fieldSx}
          />
          <TextField label="Phone" required value={form.phone} onChange={(event) => update('phone', event.target.value)} sx={fieldSx} />
          <TextField
            select
            label="Sort order"
            value={form.sort_order}
            onChange={(event) => update('sort_order', event.target.value)}
            sx={fieldSx}
          >
            <MenuItem value="">Keep current</MenuItem>
            {[1, 2, 3, 4, 5].map((value) => <MenuItem key={value} value={String(value)}>{value}</MenuItem>)}
          </TextField>
          <FormControlLabel
            control={<Switch checked={form.is_active} onChange={(event) => update('is_active', event.target.checked)} />}
            label={<Typography sx={{ fontSize: '1.1rem' }}>Active</Typography>}
          />
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button type="submit" variant="contained" disabled={saving} sx={{ bgcolor: brand.orange, color: '#111', fontWeight: 800, fontSize: '1.05rem', '&:hover': { bgcolor: brand.orangeDark, color: '#fff' } }}>
              {saving ? 'Saving...' : editingId ? 'Save location' : 'Add location'}
            </Button>
            {editingId ? (
              <Button onClick={() => { setEditingId(null); setForm(emptyForm); }} sx={{ fontSize: '1.05rem' }}>Cancel</Button>
            ) : null}
          </Box>
        </Box>
      </SectionCard>

      <SectionCard title="Shops">
        {loading ? <LoadingState message="Loading locations..." /> : null}
        <Box sx={{ display: 'grid', gap: 1.5 }}>
          {locations.map((location) => (
            <Box
              key={location.id}
              data-testid={`location-card-${location.name}`}
              sx={{
                bgcolor: '#fff',
                border: `1px solid ${brand.border}`,
                borderLeft: `6px solid ${location.is_active ? brand.orange : brand.muted}`,
                borderRadius: 1.5,
                p: 2,
                display: 'flex',
                justifyContent: 'space-between',
                gap: 2,
                flexWrap: 'wrap',
              }}
            >
              <Box>
                <Typography sx={{ color: brand.navy, fontWeight: 800, fontSize: '1.45rem' }}>{location.name}</Typography>
                <Typography sx={{ whiteSpace: 'pre-wrap', fontSize: '1.12rem', mt: 0.5 }}>{location.address}</Typography>
                <Typography sx={{ fontSize: '1.12rem', fontWeight: 700, mt: 0.5 }}>{location.phone}</Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Chip label={location.is_active ? 'Active' : 'Inactive'} sx={{ fontWeight: 800, fontSize: '0.95rem', bgcolor: location.is_active ? brand.navy : '#e7edf4', color: location.is_active ? '#fff' : brand.text }} />
                <Button onClick={() => edit(location)} sx={{ fontWeight: 800, fontSize: '1.05rem', color: brand.navy }}>Edit</Button>
              </Box>
            </Box>
          ))}
        </Box>
      </SectionCard>
    </Box>
  );
}
