import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { authFetch } from '../api';

const LOCATION_STORAGE_KEY = 'lp_scan_location';

function formatStamp(value) {
  if (!value) return '—';
  return String(value).replace('T', ' ').slice(0, 19);
}

export default function BarcodeScan() {
  const navigate = useNavigate();
  const scanRef = useRef(null);
  const [scannedValue, setScannedValue] = useState('');
  const [location, setLocation] = useState(() => sessionStorage.getItem(LOCATION_STORAGE_KEY) || '');
  const [locationStages, setLocationStages] = useState([]);
  const [locations, setLocations] = useState([]);
  const [events, setEvents] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function focusScan() {
    scanRef.current?.focus();
  }

  function loadEvents() {
    return authFetch('/api/barcode/events?limit=15')
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load recent scans');
        setEvents(body.events || []);
      })
      .catch((err) => setError(err.message || 'Unable to load recent scans'));
  }

  useEffect(() => {
    authFetch('/api/barcode/config')
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((body) => {
        if (body?.locationStages) setLocationStages(body.locationStages);
        if (body?.locations) setLocations(body.locations);
      })
      .catch(() => {});
    loadEvents();
    focusScan();
  }, []);

  useEffect(() => {
    sessionStorage.setItem(LOCATION_STORAGE_KEY, location);
  }, [location]);

  async function submitScan(event) {
    event.preventDefault();
    const value = scannedValue.trim();
    if (!value || submitting) {
      focusScan();
      return;
    }

    setSubmitting(true);
    setError('');
    setNotice('');
    try {
      const response = await authFetch('/api/barcode', {
        method: 'POST',
        body: JSON.stringify({
          scanned_value: value,
          location: location.trim() || null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Scan failed');
      const label = body.external_id || `#${body.work_order_id}`;
      const stageNote = body.stage_advanced && body.stage_name ? ` Stage set to ${body.stage_name}.` : '';
      setNotice(`Recorded ${label}.${stageNote}`);
      setScannedValue('');
      await loadEvents();
    } catch (err) {
      setError(err.message || 'Scan failed');
    } finally {
      setSubmitting(false);
      focusScan();
    }
  }

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Scan
      </Typography>
      <Typography color="text.secondary" gutterBottom>
        Scan a work order barcode or type its number. A keyboard wedge scanner can type into the field and press Enter.
      </Typography>

      <Card sx={{ bgcolor: '#ffffff', mb: 3 }}>
        <CardContent>
          <Box component="form" onSubmit={submitScan} sx={{ display: 'grid', gap: 2 }}>
            <TextField
              label="Location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              helperText="Optional station. A saved location can move the work order to a department or advance a production stage."
              fullWidth
            />
            {(locations.length > 0 ? locations : locationStages).length > 0 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {(locations.length > 0 ? locations : locationStages).map((entry) => (
                  <Chip
                    key={entry.id || entry.location}
                    label={entry.location}
                    clickable
                    color={location.trim().toLowerCase() === entry.location.toLowerCase() ? 'primary' : 'default'}
                    onClick={() => {
                      setLocation(entry.location);
                      focusScan();
                    }}
                  />
                ))}
              </Box>
            )}
            <TextField
              inputRef={scanRef}
              label="Barcode"
              value={scannedValue}
              onChange={(e) => setScannedValue(e.target.value)}
              placeholder="WO-1001"
              autoComplete="off"
              autoFocus
              fullWidth
            />
            <Box>
              <Button type="submit" variant="contained" disabled={submitting || !scannedValue.trim()}>
                {submitting ? 'Recording...' : 'Record scan'}
              </Button>
            </Box>
          </Box>
          {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
          {notice && <Alert severity="success" sx={{ mt: 2 }}>{notice}</Alert>}
        </CardContent>
      </Card>

      <Card sx={{ bgcolor: '#ffffff' }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Recent scans
          </Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Time</TableCell>
                  <TableCell>Scanned</TableCell>
                  <TableCell>Work order</TableCell>
                  <TableCell>Location</TableCell>
                  <TableCell>Operator</TableCell>
                  <TableCell>Stage</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {events.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6}>No scans yet.</TableCell>
                  </TableRow>
                )}
                {events.map((event) => (
                  <TableRow key={event.id} hover>
                    <TableCell>{formatStamp(event.event_time)}</TableCell>
                    <TableCell>{event.scanned_value}</TableCell>
                    <TableCell>
                      {event.work_order_id ? (
                        <Button size="small" onClick={() => navigate(`/work-orders/${event.work_order_id}`)}>
                          {event.external_id || `#${event.work_order_id}`}
                        </Button>
                      ) : '—'}
                    </TableCell>
                    <TableCell>{event.location || '—'}</TableCell>
                    <TableCell>{event.operator_name || event.operator_username || '—'}</TableCell>
                    <TableCell>{event.stage_name || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Box>
  );
}
