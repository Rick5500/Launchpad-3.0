import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  MenuItem,
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

const TYPES = [
  '',
  'work_order.created',
  'work_order.moved',
  'work_order.completed',
  'work_order.approved',
  'work_order.rejected',
  'service.created',
  'service.updated',
  'service.deactivated',
  'service.reactivated',
  'user.created',
  'user.updated',
  'user.deactivated',
  'user.password_reset',
  'settings.updated',
  'notification_settings.updated',
  'barcode_location.created',
  'barcode_location.updated',
  'barcode_location.removed',
];

export default function ActivityLogPage() {
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState({ from: '', to: '', user: '', type: '', q: '' });
  const [applied, setApplied] = useState(filters);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const limit = 25;

  function query(extra = {}) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(extra.offset ?? offset) });
    const source = extra.applied || applied;
    if (source.from) params.set('from', source.from);
    if (source.to) params.set('to', source.to);
    if (source.user) params.set('user', source.user);
    if (source.type) params.set('type', source.type);
    if (source.q) params.set('q', source.q);
    if (extra.format) {
      params.set('format', extra.format);
      params.set('limit', '200');
      params.set('offset', '0');
    }
    return params;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authFetch(`/api/activity?${query().toString()}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load activity');
        if (cancelled) return;
        setEntries(body.entries || []);
        setTotal(body.total || 0);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load activity');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [offset, applied]);

  async function exportCsv() {
    setError('');
    const response = await authFetch(`/api/activity?${query({ format: 'csv', offset: 0 }).toString()}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error || 'Unable to export activity');
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'activity-log.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Box data-testid="activity-log-page">
      <Typography variant="h4" gutterBottom>Activity Log</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Work order events and administrator changes. Export respects the current filters.
      </Typography>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
      <SectionCard title="Filters">
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            setOffset(0);
            setApplied(filters);
          }}
          sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}
        >
          <TextField label="From" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} InputLabelProps={{ shrink: true }} />
          <TextField label="To" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} InputLabelProps={{ shrink: true }} />
          <TextField label="User" value={filters.user} onChange={(event) => setFilters({ ...filters, user: event.target.value })} helperText="Id or username" />
          <TextField select label="Type" value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value })} sx={{ minWidth: 220 }}>
            {TYPES.map((type) => <MenuItem key={type || 'all'} value={type}>{type || 'All types'}</MenuItem>)}
          </TextField>
          <TextField label="Search" value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} />
          <Button type="submit" variant="contained">Apply</Button>
          <Button variant="outlined" onClick={exportCsv}>Export CSV</Button>
        </Box>
      </SectionCard>
      <SectionCard title="Entries">
        {loading ? <LoadingState message="Loading activity..." /> : null}
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>When</TableCell>
                <TableCell>Who</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>What</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{String(entry.created_at || '').replace('T', ' ').slice(0, 19)}</TableCell>
                  <TableCell>{entry.actor_name || entry.actor_username || '—'}</TableCell>
                  <TableCell>{entry.action}</TableCell>
                  <TableCell>{entry.summary}</TableCell>
                </TableRow>
              ))}
              {!loading && entries.length === 0 ? (
                <TableRow><TableCell colSpan={4}>No activity in this range.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </TableContainer>
        <Pager offset={offset} limit={limit} total={total} onChange={setOffset} />
      </SectionCard>
    </Box>
  );
}
