import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  FormControlLabel,
  Grid,
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
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import SectionCard from '../components/SectionCard';
import { authFetch } from '../api';
import { useAuth } from '../context/AuthContext';

const STATUSES = ['pending', 'scheduled', 'out-for-delivery', 'complete'];
const TIMING_FILTERS = [
  { value: '', label: 'All timing' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'due_today', label: 'Due today' },
  { value: 'due_soon', label: 'Due soon' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'complete', label: 'Complete' },
];

const timingLabels = {
  overdue: 'Overdue',
  due_today: 'Due today',
  due_soon: 'Due soon',
  upcoming: 'Upcoming',
  complete: 'Complete',
  unscheduled: 'No due time',
};

const timingColors = {
  overdue: 'error',
  due_today: 'warning',
  due_soon: 'info',
  upcoming: 'default',
  complete: 'success',
  unscheduled: 'default',
};

const emptyForm = {
  work_order: '',
  will_call: false,
  due_time: '',
  carrier: '',
  status: 'pending',
};

function formatStamp(value) {
  if (!value) return '—';
  return String(value).replace('T', ' ').slice(0, 19);
}

function toDateTimeLocal(value) {
  if (!value) return '';
  const text = String(value).replace(' ', 'T');
  return text.slice(0, 16);
}

function rowTint(delivery) {
  if (delivery.overdue) return 'rgba(239, 83, 80, 0.18)';
  if (delivery.due_today) return 'rgba(255, 183, 77, 0.16)';
  if (delivery.due_soon) return 'rgba(144, 202, 249, 0.12)';
  return 'inherit';
}

export default function Deliveries() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canWrite = user?.role === 'admin' || user?.role === 'operator';
  const [deliveries, setDeliveries] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [rules, setRules] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [timingFilter, setTimingFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const limit = 20;

  function load(nextOffset = offset, nextStatus = statusFilter, nextTiming = timingFilter) {
    setLoading(true);
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(nextOffset));
    if (nextStatus) params.set('status', nextStatus);
    if (nextTiming) params.set('timing', nextTiming);

    return authFetch(`/api/delivery?${params.toString()}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load deliveries');
        setDeliveries(body.deliveries || []);
        setTotal(body.total || 0);
        setOffset(body.offset || 0);
        setError('');
      })
      .catch((err) => setError(err.message || 'Unable to load deliveries'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    authFetch('/api/delivery/rules')
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((body) => {
        if (body?.rules) setRules(body);
      })
      .catch(() => {});
    load(0, '', '');
  }, []);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function startEdit(delivery) {
    setEditingId(delivery.id);
    setForm({
      work_order: delivery.external_id || String(delivery.work_order_id || ''),
      will_call: Boolean(delivery.will_call),
      due_time: toDateTimeLocal(delivery.due_time),
      carrier: delivery.carrier || '',
      status: delivery.status || 'pending',
    });
    setFormError('');
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError('');
  }

  async function saveDelivery(event) {
    event.preventDefault();
    setFormError('');
    setSaving(true);
    try {
      const payload = {
        will_call: form.will_call,
        due_time: form.due_time || null,
        carrier: form.carrier.trim() || null,
        status: form.status,
      };
      let url = '/api/delivery';
      let method = 'POST';
      if (editingId) {
        url = `/api/delivery/${editingId}`;
        method = 'PUT';
      } else {
        const workOrder = form.work_order.trim();
        if (!workOrder) throw new Error('Enter a work order id or external id.');
        if (/^[1-9]\d*$/.test(workOrder)) payload.work_order_id = Number(workOrder);
        else payload.external_id = workOrder;
      }

      const response = await authFetch(url, { method, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to save delivery');
      cancelEdit();
      await load(0);
    } catch (err) {
      setFormError(err.message || 'Unable to save delivery');
    } finally {
      setSaving(false);
    }
  }

  if (loading && !deliveries.length && !error) return <LoadingState message="Loading deliveries..." />;
  if (error && !deliveries.length) return <ErrorState message={error} />;

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Deliveries
      </Typography>
      <Typography color="text.secondary" gutterBottom>
        {canWrite
          ? 'Schedule will-call and carrier deliveries. Due times left blank follow the cutoff rules.'
          : 'Deliveries for your work orders.'}
      </Typography>

      {rules && (
        <SectionCard title="Due-time rules" subtitle={rules.rules.summary}>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6} md={3}>
              <Typography variant="subtitle2" color="text.secondary">Will-call cutoff</Typography>
              <Typography>{rules.rules.willCallCutoff}</Typography>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Typography variant="subtitle2" color="text.secondary">Carrier cutoff</Typography>
              <Typography>{rules.rules.carrierCutoff}</Typography>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Typography variant="subtitle2" color="text.secondary">Will-call if ready now</Typography>
              <Typography>{formatStamp(rules.computed?.willCall?.suggestedDueTime)}</Typography>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Typography variant="subtitle2" color="text.secondary">Carrier if ready now</Typography>
              <Typography>{formatStamp(rules.computed?.carrier?.suggestedDueTime)}</Typography>
            </Grid>
          </Grid>
        </SectionCard>
      )}

      {canWrite && (
        <Card sx={{ bgcolor: '#1f2a38', mb: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              {editingId ? `Edit delivery #${editingId}` : 'New delivery'}
            </Typography>
            <Box component="form" onSubmit={saveDelivery}>
              <Grid container spacing={2}>
                <Grid item xs={12} md={4}>
                  <TextField
                    label="Work order"
                    value={form.work_order}
                    onChange={(e) => updateField('work_order', e.target.value)}
                    placeholder="WO-1001"
                    helperText="Id or external id such as WO-1001"
                    disabled={Boolean(editingId)}
                    fullWidth
                  />
                </Grid>
                <Grid item xs={12} md={4}>
                  <TextField
                    label="Due time"
                    type="datetime-local"
                    value={form.due_time}
                    onChange={(e) => updateField('due_time', e.target.value)}
                    InputLabelProps={{ shrink: true }}
                    helperText="Blank uses the cutoff rule"
                    fullWidth
                  />
                </Grid>
                <Grid item xs={12} md={4}>
                  <TextField
                    label="Carrier"
                    value={form.carrier}
                    onChange={(e) => updateField('carrier', e.target.value)}
                    fullWidth
                  />
                </Grid>
                <Grid item xs={12} md={4}>
                  <TextField
                    select
                    label="Status"
                    value={form.status}
                    onChange={(e) => updateField('status', e.target.value)}
                    fullWidth
                  >
                    {STATUSES.map((status) => (
                      <MenuItem key={status} value={status}>{status}</MenuItem>
                    ))}
                  </TextField>
                </Grid>
                <Grid item xs={12} md={4} sx={{ display: 'flex', alignItems: 'center' }}>
                  <FormControlLabel
                    control={<Switch checked={form.will_call} onChange={(e) => updateField('will_call', e.target.checked)} />}
                    label="Will call"
                  />
                </Grid>
                <Grid item xs={12} md={4} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Button type="submit" variant="contained" disabled={saving}>
                    {saving ? 'Saving...' : (editingId ? 'Update delivery' : 'Create delivery')}
                  </Button>
                  {editingId && (
                    <Button onClick={cancelEdit} disabled={saving}>Cancel</Button>
                  )}
                </Grid>
              </Grid>
            </Box>
            {formError && <Alert severity="error" sx={{ mt: 2 }}>{formError}</Alert>}
          </CardContent>
        </Card>
      )}

      <Card sx={{ bgcolor: '#1f2a38' }}>
        <CardContent>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 2 }}>
            <TextField
              select
              label="Status"
              size="small"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                load(0, e.target.value, timingFilter);
              }}
              sx={{ minWidth: 180 }}
            >
              <MenuItem value="">All statuses</MenuItem>
              {STATUSES.map((status) => (
                <MenuItem key={status} value={status}>{status}</MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="Timing"
              size="small"
              value={timingFilter}
              onChange={(e) => {
                setTimingFilter(e.target.value);
                load(0, statusFilter, e.target.value);
              }}
              sx={{ minWidth: 180 }}
            >
              {TIMING_FILTERS.map((option) => (
                <MenuItem key={option.value || 'all'} value={option.value}>{option.label}</MenuItem>
              ))}
            </TextField>
          </Box>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Work order</TableCell>
                  <TableCell>Customer</TableCell>
                  <TableCell>Due</TableCell>
                  <TableCell>Timing</TableCell>
                  <TableCell>Carrier</TableCell>
                  <TableCell>Status</TableCell>
                  {canWrite && <TableCell>Edit</TableCell>}
                </TableRow>
              </TableHead>
              <TableBody>
                {deliveries.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={canWrite ? 7 : 6}>No deliveries match these filters.</TableCell>
                  </TableRow>
                )}
                {deliveries.map((delivery) => (
                  <TableRow key={delivery.id} sx={{ bgcolor: rowTint(delivery) }}>
                    <TableCell>
                      {delivery.work_order_id ? (
                        <Button size="small" onClick={() => navigate(`/work-orders/${delivery.work_order_id}`)}>
                          {delivery.external_id || `#${delivery.work_order_id}`}
                        </Button>
                      ) : '—'}
                      {delivery.will_call ? <Chip size="small" label="Will call" color="secondary" sx={{ ml: 1 }} /> : null}
                    </TableCell>
                    <TableCell>{delivery.customer_name || '—'}</TableCell>
                    <TableCell>{formatStamp(delivery.due_time)}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={timingLabels[delivery.timing] || delivery.timing}
                        color={timingColors[delivery.timing] || 'default'}
                      />
                    </TableCell>
                    <TableCell>{delivery.carrier || '—'}</TableCell>
                    <TableCell>{delivery.status}</TableCell>
                    {canWrite && (
                      <TableCell>
                        <Button size="small" onClick={() => startEdit(delivery)}>Edit</Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 2 }}>
            <Typography variant="body2" color="text.secondary">
              {total} deliveries
            </Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button disabled={offset === 0 || loading} onClick={() => load(Math.max(0, offset - limit))}>
                Previous
              </Button>
              <Button disabled={loading || offset + deliveries.length >= total} onClick={() => load(offset + limit)}>
                Next
              </Button>
            </Box>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
