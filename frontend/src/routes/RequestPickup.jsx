import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Grid,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import SectionCard from '../components/SectionCard';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { authFetch } from '../api';
import { useAuth } from '../context/AuthContext';
import { brand } from '../brand';

const STATUS_LABELS = {
  new: 'New',
  scheduled: 'Scheduled',
  picked_up: 'Picked up',
  cancelled: 'Cancelled',
};

const fieldSx = {
  '& .MuiInputBase-input': { fontSize: '1.125rem' },
  '& .MuiInputLabel-root': { fontSize: '1.05rem' },
};

function emptyForm(user) {
  return {
    location_id: user?.location_id ? String(user.location_id) : '',
    contact_name: user?.contact_name || user?.display_name || '',
    contact_phone: user?.phone || '',
    address_line1: user?.address_line1 || '',
    address_line2: user?.address_line2 || '',
    city: user?.city || '',
    state: user?.state || '',
    zip: user?.zip || '',
    ready_date: '',
    ready_time: '',
    notes: '',
    order_id: '',
  };
}

export default function RequestPickup() {
  const { user } = useAuth();
  const [form, setForm] = useState(() => emptyForm(user));
  const [locations, setLocations] = useState([]);
  const [orders, setOrders] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function load() {
    const [configResponse, orderResponse, listResponse] = await Promise.all([
      authFetch('/api/auth/config'),
      authFetch('/api/orders?limit=100'),
      authFetch('/api/pickup-requests'),
    ]);
    const config = await configResponse.json().catch(() => ({}));
    const orderBody = await orderResponse.json().catch(() => ({}));
    const listBody = await listResponse.json().catch(() => ({}));
    if (!listResponse.ok) throw new Error(listBody.error || 'Unable to load pickup requests');
    setLocations(config.locations || []);
    setOrders(orderBody.orders || []);
    setRequests(listBody.pickup_requests || []);
  }

  useEffect(() => {
    setForm((current) => ({
      ...emptyForm(user),
      ready_date: current.ready_date,
      ready_time: current.ready_time,
      notes: current.notes,
      order_id: current.order_id,
      location_id: current.location_id || (user?.location_id ? String(user.location_id) : ''),
    }));
    load()
      .catch((err) => setError(err.message || 'Unable to load pickup requests'))
      .finally(() => setLoading(false));
  }, [user]);

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        location_id: form.location_id ? Number(form.location_id) : undefined,
        contact_name: form.contact_name.trim(),
        contact_phone: form.contact_phone.trim(),
        address_line1: form.address_line1.trim(),
        address_line2: form.address_line2.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        zip: form.zip.trim(),
        ready_date: form.ready_date,
        ready_time: form.ready_time || null,
        notes: form.notes.trim() || null,
        order_id: form.order_id ? Number(form.order_id) : null,
      };
      const response = await authFetch('/api/pickup-requests', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to request a pickup');
      setNotice('Your pickup request was sent. A confirmation email is on its way when mail is set up.');
      setForm((current) => ({ ...emptyForm(user), location_id: current.location_id }));
      await load();
    } catch (err) {
      setError(err.message || 'Unable to request a pickup');
    } finally {
      setSaving(false);
    }
  }

  async function cancelRequest(id) {
    setError('');
    const response = await authFetch(`/api/pickup-requests/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'cancelled' }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error || 'Unable to cancel that pickup');
      return;
    }
    await load();
  }

  if (loading) return <LoadingState message="Loading pickup requests..." />;
  if (error && !requests.length && !locations.length) return <ErrorState message={error} />;

  return (
    <Box data-testid="request-pickup-page">
      <Typography variant="h4" sx={{ fontWeight: 700, color: brand.navy, mb: 1, fontSize: { xs: '1.85rem', sm: '2.125rem' } }}>
        Request a Pickup
      </Typography>
      <Typography sx={{ fontSize: '1.125rem', lineHeight: 1.5, color: brand.text, mb: 3, maxWidth: 760 }}>
        Ask Accent to send a vehicle for your originals. This is not a delivery of finished work. The address starts from your account, and the shop starts from your default location.
      </Typography>

      <SectionCard title="Pickup details">
        <Box component="form" onSubmit={submit} data-testid="request-pickup-form">
          <Grid container spacing={2}>
            <Grid item xs={12} md={6}>
              <TextField select label="Shop location" value={form.location_id} onChange={(event) => update('location_id', event.target.value)} required fullWidth sx={fieldSx}>
                {locations.map((location) => (
                  <MenuItem key={location.id} value={String(location.id)}>{location.name}</MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid item xs={12} md={6}>
              <TextField select label="Related order" value={form.order_id} onChange={(event) => update('order_id', event.target.value)} fullWidth sx={fieldSx}>
                <MenuItem value="">None</MenuItem>
                {orders.map((order) => (
                  <MenuItem key={order.id} value={String(order.id)}>
                    {order.order_number} · {order.project_name || 'Order'}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid item xs={12} md={6}>
              <TextField label="Contact name" value={form.contact_name} onChange={(event) => update('contact_name', event.target.value)} required fullWidth sx={fieldSx} />
            </Grid>
            <Grid item xs={12} md={6}>
              <TextField label="Contact phone" value={form.contact_phone} onChange={(event) => update('contact_phone', event.target.value)} required fullWidth sx={fieldSx} />
            </Grid>
            <Grid item xs={12}>
              <TextField label="Pickup address" value={form.address_line1} onChange={(event) => update('address_line1', event.target.value)} required fullWidth sx={fieldSx} />
            </Grid>
            <Grid item xs={12}>
              <TextField label="Address line 2" value={form.address_line2} onChange={(event) => update('address_line2', event.target.value)} fullWidth sx={fieldSx} />
            </Grid>
            <Grid item xs={12} md={5}>
              <TextField label="City" value={form.city} onChange={(event) => update('city', event.target.value)} required fullWidth sx={fieldSx} />
            </Grid>
            <Grid item xs={6} md={3}>
              <TextField label="State" value={form.state} onChange={(event) => update('state', event.target.value)} required fullWidth sx={fieldSx} />
            </Grid>
            <Grid item xs={6} md={4}>
              <TextField label="ZIP" value={form.zip} onChange={(event) => update('zip', event.target.value)} required fullWidth sx={fieldSx} />
            </Grid>
            <Grid item xs={12} md={6}>
              <TextField label="Ready date" type="date" value={form.ready_date} onChange={(event) => update('ready_date', event.target.value)} required fullWidth InputLabelProps={{ shrink: true }} sx={fieldSx} />
            </Grid>
            <Grid item xs={12} md={6}>
              <TextField label="Ready time" type="time" value={form.ready_time} onChange={(event) => update('ready_time', event.target.value)} fullWidth InputLabelProps={{ shrink: true }} sx={fieldSx} />
            </Grid>
            <Grid item xs={12}>
              <TextField label="Notes" value={form.notes} onChange={(event) => update('notes', event.target.value)} multiline minRows={3} fullWidth sx={fieldSx} placeholder="Where to meet the driver, or what to pick up" />
            </Grid>
            <Grid item xs={12}>
              <Button type="submit" variant="contained" size="large" disabled={saving} sx={{ bgcolor: brand.orange, color: '#111', fontWeight: 700, fontSize: '1.05rem', '&:hover': { bgcolor: brand.orangeDark } }}>
                {saving ? 'Sending...' : 'Request pickup'}
              </Button>
            </Grid>
          </Grid>
        </Box>
        {notice ? <Alert severity="success" sx={{ mt: 2, fontSize: '1.05rem' }}>{notice}</Alert> : null}
        {error ? <Alert severity="error" sx={{ mt: 2, fontSize: '1.05rem' }}>{error}</Alert> : null}
      </SectionCard>

      <SectionCard title="Your pickup requests">
        {requests.length === 0 ? (
          <Typography sx={{ fontSize: '1.125rem' }}>You have no pickup requests yet.</Typography>
        ) : (
          <Box sx={{ display: 'grid', gap: 2 }}>
            {requests.map((request) => (
              <Box key={request.id} sx={{ border: `1px solid ${brand.border}`, borderRadius: 1, p: 2 }}>
                <Typography sx={{ fontSize: '1.2rem', fontWeight: 700, color: brand.navy }}>
                  {STATUS_LABELS[request.status] || request.status}
                  {request.order_number ? ` · Order ${request.order_number}` : ''}
                </Typography>
                <Typography sx={{ fontSize: '1.05rem', lineHeight: 1.5, mt: 0.5 }}>
                  {request.address_line1}
                  {request.address_line2 ? `, ${request.address_line2}` : ''}
                  {`, ${request.city}, ${request.state} ${request.zip}`}
                </Typography>
                <Typography sx={{ fontSize: '1.05rem', lineHeight: 1.5 }}>
                  Ready {request.ready_date}{request.ready_time ? ` at ${request.ready_time}` : ''}
                  {request.location_name ? ` · ${request.location_name}` : ''}
                </Typography>
                {request.notes ? (
                  <Typography sx={{ fontSize: '1.05rem', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{request.notes}</Typography>
                ) : null}
                {(request.status === 'new' || request.status === 'scheduled') ? (
                  <Button sx={{ mt: 1, fontSize: '1rem' }} onClick={() => cancelRequest(request.id)}>Cancel request</Button>
                ) : null}
              </Box>
            ))}
          </Box>
        )}
      </SectionCard>
    </Box>
  );
}
