import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
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
import { authFetch } from '../api';
import { requestBoardRefresh } from '../boardEvents';
import { useAuth } from '../context/AuthContext';

const LOCATION_STORAGE_KEY = 'lp_scan_location';

const LEGACY_SAVED_ALIASES = {
  'quality control': 'quality',
  shipping: 'dispatch',
};

function formatStamp(value) {
  if (!value) return '—';
  return String(value).replace('T', ' ').slice(0, 19);
}

function locationOptionLabel(entry) {
  const name = String(entry.location || '').trim();
  const department = String(entry.department_name || '').trim();
  if (department && department.toLowerCase() === name.toLowerCase()) return department;
  if (department) return `${name} → ${department}`;
  return `${name} (stage only — department unchanged)`;
}

function selectableLocations(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && row.location && row.is_active !== false);
  const departmentNamed = new Set(
    list
      .filter((row) => String(row.department_name || '').trim().toLowerCase() === String(row.location).trim().toLowerCase())
      .map((row) => String(row.department_name).trim().toLowerCase())
  );
  return list
    .filter((row) => {
      const key = String(row.location).trim().toLowerCase();
      const department = String(row.department_name || '').trim().toLowerCase();
      const legacy = Object.prototype.hasOwnProperty.call(LEGACY_SAVED_ALIASES, key);
      if (legacy && department && departmentNamed.has(department)) return false;
      return true;
    })
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.location).localeCompare(String(b.location)));
}

function scanResult(body) {
  const label = body.external_id || `#${body.work_order_id}`;
  const stageNote = body.stage_advanced && body.stage_name ? ` Stage set to ${body.stage_name}.` : '';
  const from = body.from_department || 'unassigned';
  const to = body.to_department || from;
  if (body.department_moved) {
    return {
      severity: 'success',
      text: `Recorded ${label}. Moved from ${from} to ${body.to_department}.${stageNote}`,
    };
  }
  const stayed = {
    same_department: `Recorded ${label}. Already in ${to}, so the department stayed in ${to}.`,
    stage_only: `Recorded ${label}. This location does not move the department. It stayed in ${from}.`,
    unknown_location: `Recorded ${label}. That location is not a scan location, so the department stayed in ${from}.`,
    no_location: `Recorded ${label}. No location was selected, so the department stayed in ${from}.`,
    department_not_found: `Recorded ${label}. The location's department was not found, so the department stayed in ${from}.`,
  };
  const text = stayed[body.department_move_reason]
    || `Recorded ${label}. The department stayed in ${from}.`;
  return { severity: 'warning', text: `${text}${stageNote}` };
}

export default function BarcodeScan() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const assignedDepartment = user?.department || '';
  const scanRef = useRef(null);
  const [scannedValue, setScannedValue] = useState('');
  const [location, setLocation] = useState(() => sessionStorage.getItem(LOCATION_STORAGE_KEY) || '');
  const [locationStages, setLocationStages] = useState([]);
  const [locations, setLocations] = useState([]);
  const [events, setEvents] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

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

  const locationOptions = selectableLocations(locations);

  useEffect(() => {
    if (!assignedDepartment) return;
    setLocation(assignedDepartment);
  }, [assignedDepartment]);

  useEffect(() => {
    if (assignedDepartment || !locations.length) return;
    const options = selectableLocations(locations);
    const current = location.trim().toLowerCase();
    const match = options.find((entry) => entry.location.toLowerCase() === current);
    if (match) {
      if (match.location !== location) setLocation(match.location);
      return;
    }
    const alias = LEGACY_SAVED_ALIASES[current];
    if (alias) {
      const preferred = options.find((entry) => entry.location.toLowerCase() === alias);
      if (preferred) {
        setLocation(preferred.location);
        return;
      }
    }
    if (current) setLocation('');
  }, [assignedDepartment, locations, location]);

  useEffect(() => {
    if (assignedDepartment) return;
    sessionStorage.setItem(LOCATION_STORAGE_KEY, location);
  }, [location, assignedDepartment]);

  async function submitScan(event) {
    event.preventDefault();
    const value = scannedValue.trim();
    if (!value || submitting) {
      focusScan();
      return;
    }

    setSubmitting(true);
    setError('');
    setResult(null);
    try {
      const response = await authFetch('/api/barcode', {
        method: 'POST',
        body: JSON.stringify({
          scanned_value: value,
          location: assignedDepartment || location.trim() || null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Scan failed');
      setResult(scanResult(body));
      setScannedValue('');
      requestBoardRefresh();
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
            {assignedDepartment ? (
              <Alert severity="info">
                Scans move work orders to {assignedDepartment}.
              </Alert>
            ) : locationOptions.length > 0 ? (
              <TextField
                select
                label="Location"
                value={locationOptions.some((entry) => entry.location === location) ? location : ''}
                onChange={(e) => setLocation(e.target.value)}
                helperText="The work order moves to the department shown. A stage-only location leaves the department where it is."
                fullWidth
              >
                <MenuItem value="">No location</MenuItem>
                {locationOptions.map((entry) => (
                  <MenuItem key={entry.id || entry.location} value={entry.location}>
                    {locationOptionLabel(entry)}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <TextField
                label="Location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                helperText={locationStages.length
                  ? 'No saved locations yet. A typed department name moves the work order there.'
                  : 'Optional station. A saved location can move the work order to a department.'}
                fullWidth
              />
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
          {result && <Alert severity={result.severity} sx={{ mt: 2 }}>{result.text}</Alert>}
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
