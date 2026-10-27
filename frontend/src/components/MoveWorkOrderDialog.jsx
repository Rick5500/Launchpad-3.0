import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
} from '@mui/material';
import { authFetch } from '../api';
import { useAuth } from '../context/AuthContext';

function isActiveDepartment(row) {
  return row && row.is_active !== 0 && row.is_active !== false;
}

function sameDepartment(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function currentShopId(workOrder, shops) {
  if (!workOrder) return '';
  const direct = workOrder.location_id != null && workOrder.location_id !== ''
    ? workOrder.location_id
    : workOrder.order_location_id;
  if (direct != null && direct !== '') return String(direct);
  const named = workOrder.location_name
    ? (shops || []).find((shop) => shop.name === workOrder.location_name)
    : null;
  if (named) return String(named.id);
  const raleigh = (shops || []).find((shop) => String(shop.name || '').toLowerCase() === 'raleigh');
  return raleigh ? String(raleigh.id) : '';
}

export default function MoveWorkOrderDialog({ open, workOrder, onClose, onMoved }) {
  const { user } = useAuth();
  const canChangeLocation = user?.role === 'admin' || user?.role === 'manager';
  const [departments, setDepartments] = useState([]);
  const [locations, setLocations] = useState([]);
  const [department, setDepartment] = useState('');
  const [locationId, setLocationId] = useState('');
  const [initialLocationId, setInitialLocationId] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const current = workOrder?.department || '';
  const label = workOrder?.external_id || workOrder?.order_number || (workOrder ? `#${workOrder.id}` : 'work order');

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setDepartment('');
    setNote('');
    setError('');
    setLocations([]);
    const preset = currentShopId(workOrder, []);
    setLocationId(preset);
    setInitialLocationId(preset);
    setLoading(true);
    const departmentRequest = authFetch('/api/departments')
      .then(async (response) => {
        const body = await response.json().catch(() => []);
        if (!response.ok) throw new Error(body.error || 'Unable to load departments');
        if (!Array.isArray(body)) throw new Error('Unable to load departments');
        return body.filter(isActiveDepartment);
      });
    const locationRequest = canChangeLocation
      ? authFetch('/api/locations').then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load locations');
        return body.locations || [];
      })
      : Promise.resolve([]);
    Promise.all([departmentRequest, locationRequest])
      .then(([rows, shops]) => {
        if (cancelled) return;
        setDepartments(rows);
        setLocations(shops);
        if (canChangeLocation) {
          const next = currentShopId(workOrder, shops);
          setLocationId(next);
          setInitialLocationId(next);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load departments');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, canChangeLocation, workOrder]);

  const selectedIsCurrent = useMemo(
    () => Boolean(department) && sameDepartment(department, current),
    [department, current]
  );
  const locationChanged = canChangeLocation
    && locationId !== ''
    && locationId !== initialLocationId;
  const currentLocationName = useMemo(() => {
    const match = locations.find((row) => String(row.id) === String(initialLocationId));
    return match?.name || workOrder?.location_name || '';
  }, [locations, initialLocationId, workOrder]);

  async function confirm() {
    const destination = department || current;
    const keepingDepartment = !department || selectedIsCurrent;
    if (!workOrder || !destination || (keepingDepartment && !locationChanged)) return;
    setSaving(true);
    setError('');
    try {
      const payload = {
        department: destination,
        note: note.trim() ? note.trim() : undefined,
      };
      if (canChangeLocation && locationId) payload.location_id = Number(locationId);
      const response = await authFetch(`/api/workorders/${workOrder.id}/move`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to move work order');
      const movedDepartment = body.department || destination;
      const movedLocation = body.location_changed && body.location_name ? ` at ${body.location_name}` : '';
      onMoved(`Moved ${label} to ${movedDepartment}${movedLocation}.`);
      onClose();
    } catch (err) {
      setError(err.message || 'Unable to move work order');
    } finally {
      setSaving(false);
    }
  }

  const keepingDepartment = !department || selectedIsCurrent;
  const canConfirm = Boolean(department || current) && (!keepingDepartment || locationChanged);

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="xs" data-testid="move-work-order-dialog">
      <DialogTitle>Move to…</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: 1 }}>
        {error ? <Alert severity="error">{error}</Alert> : null}
        {canChangeLocation ? (
          <TextField
            select
            label="Location"
            value={locations.some((row) => String(row.id) === String(locationId)) ? locationId : ''}
            onChange={(event) => setLocationId(event.target.value)}
            disabled={loading || saving || locations.length === 0}
            helperText={currentLocationName ? `Currently at ${currentLocationName}.` : 'Choose a shop.'}
            inputProps={{ 'data-testid': 'move-location' }}
            sx={{ mt: 2 }}
          >
            {locationId === '' ? <MenuItem value="" sx={{ display: 'none' }} /> : null}
            {locations.map((row) => (
              <MenuItem key={row.id} value={String(row.id)}>{row.name}</MenuItem>
            ))}
          </TextField>
        ) : null}
        {/* Departments are not assigned to a shop, so every active department stays listed. */}
        <TextField
          select
          label="Department"
          value={department}
          onChange={(event) => setDepartment(event.target.value)}
          disabled={loading || saving}
          helperText={current ? `Currently in ${current}.` : 'Choose an active department.'}
          inputProps={{ 'data-testid': 'move-department' }}
          SelectProps={{ SelectDisplayProps: { 'data-testid': 'move-department-display' } }}
        >
          {departments.map((row) => (
            <MenuItem key={row.id} value={row.name} disabled={sameDepartment(row.name, current)}>
              {row.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          label="Note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={saving}
          multiline
          minRows={2}
          placeholder="Optional"
          inputProps={{ 'data-testid': 'move-note', maxLength: 500 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button
          variant="contained"
          onClick={confirm}
          disabled={saving || loading || !canConfirm}
          data-testid="move-confirm"
        >
          {saving ? 'Moving…' : 'Confirm'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
