import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  MenuItem,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import SectionCard from '../components/SectionCard';
import LoadingState from '../components/LoadingState';
import { authFetch } from '../api';
import { REPORTS } from '../reportCatalog';

function formatCell(column, row) {
  const value = row[column.key];
  if (column.key === 'will_call') return value ? 'Yes' : 'No';
  if (column.key === 'average_seconds') return formatDuration(value);
  if (value == null || value === '') return '—';
  return String(value);
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return '—';
  const total = Math.max(0, Math.round(Number(seconds)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

export default function Reports() {
  const { reportId } = useParams();
  const navigate = useNavigate();
  const matched = REPORTS.findIndex((item) => item.id === reportId);
  const tab = matched >= 0 ? matched : 0;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [bucket, setBucket] = useState('day');
  const [applied, setApplied] = useState({ from: '', to: '', bucket: 'day' });
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const active = REPORTS[tab];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    if (applied.from) params.set('from', applied.from);
    if (applied.to) params.set('to', applied.to);
    if (active.bucket) params.set('bucket', applied.bucket);

    authFetch(`${active.path}?${params.toString()}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load report');
        if (!cancelled) {
          setReport(body);
          setError('');
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setReport(null);
          setError(err.message || 'Unable to load report');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [active, applied]);

  function applyFilters(event) {
    event.preventDefault();
    if (from && to && from > to) {
      setError('From must be on or before to.');
      return;
    }
    setApplied({ from, to, bucket });
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      params.set('format', 'csv');
      if (applied.from) params.set('from', applied.from);
      if (applied.to) params.set('to', applied.to);
      if (active.bucket) params.set('bucket', applied.bucket);
      const response = await authFetch(`${active.path}?${params.toString()}`, { cache: 'no-store' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Unable to export report');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = active.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Unable to export report');
    } finally {
      setExporting(false);
    }
  }

  const rows = report?.rows || [];

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Reports
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Admin and operator reports. Leave the dates empty to include all stored rows.
      </Typography>

      <SectionCard title="Filters">
        <Box component="form" onSubmit={applyFilters} sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            label="From"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            label="To"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          {active.bucket && (
            <TextField
              select
              label="Group"
              value={bucket}
              onChange={(event) => {
                const next = event.target.value;
                setBucket(next);
                setApplied((current) => ({ ...current, bucket: next }));
              }}
              sx={{ minWidth: 140 }}
            >
              <MenuItem value="day">Day</MenuItem>
              <MenuItem value="week">Week</MenuItem>
            </TextField>
          )}
          <Button type="submit" variant="contained">Apply</Button>
          <Button variant="outlined" onClick={exportCsv} disabled={exporting || loading}>
            Export CSV
          </Button>
        </Box>
      </SectionCard>

      <Tabs
        value={tab}
        onChange={(_, value) => navigate(`/reports/${REPORTS[value].id}`)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mb: 2 }}
      >
        {REPORTS.map((item) => (
          <Tab key={item.id} label={item.label} />
        ))}
      </Tabs>

      {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}

      <SectionCard title={active.label} subtitle={report?.note || active.description}>
        {loading ? <LoadingState message="Loading report..." /> : null}
        {!loading && !error && rows.length === 0 ? (
          <Typography color="text.secondary">No rows in this range.</Typography>
        ) : null}
        {!loading && !error && rows.length > 0 ? (
          <Table size="small">
            <TableHead>
              <TableRow>
                {active.columns.map((column) => (
                  <TableCell key={column.key}>{column.label}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={`${active.id}-${index}`}>
                  {active.columns.map((column) => (
                    <TableCell key={column.key}>{formatCell(column, row)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        {!loading && !error && report ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            Total {report.total != null ? report.total : rows.length}
            {active.id === 'stage-time' && report.derivable === false ? '. Stage time is not derivable from the current scans.' : ''}
          </Typography>
        ) : null}
      </SectionCard>
    </Box>
  );
}
