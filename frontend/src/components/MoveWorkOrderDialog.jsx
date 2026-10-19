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

function isActiveDepartment(row) {
  return row && row.is_active !== 0 && row.is_active !== false;
}

function sameDepartment(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

export default function MoveWorkOrderDialog({ open, workOrder, onClose, onMoved }) {
  const [departments, setDepartments] = useState([]);
  const [department, setDepartment] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const current = workOrder?.department || '';
  const label = workOrder?.order_number || workOrder?.external_id || (workOrder ? `#${workOrder.id}` : 'work order');

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setDepartment('');
    setNote('');
    setError('');
    setLoading(true);
    authFetch('/api/departments')
      .then(async (response) => {
        const body = await response.json().catch(() => []);
        if (!response.ok) throw new Error(body.error || 'Unable to load departments');
        if (!Array.isArray(body)) throw new Error('Unable to load departments');
        return body.filter(isActiveDepartment);
      })
      .then((rows) => {
        if (!cancelled) setDepartments(rows);
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
  }, [open]);

  const selectedIsCurrent = useMemo(
    () => Boolean(department) && sameDepartment(department, current),
    [department, current]
  );

  async function confirm() {
    if (!workOrder || !department || selectedIsCurrent) return;
    setSaving(true);
    setError('');
    try {
      const response = await authFetch(`/api/workorders/${workOrder.id}/move`, {
        method: 'POST',
        body: JSON.stringify({
          department,
          note: note.trim() ? note.trim() : undefined,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to move work order');
      onMoved(`Moved ${label} to ${body.department || department}.`);
      onClose();
    } catch (err) {
      setError(err.message || 'Unable to move work order');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="xs" data-testid="move-work-order-dialog">
      <DialogTitle>Move to…</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: 1 }}>
        {error ? <Alert severity="error">{error}</Alert> : null}
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
          disabled={saving || loading || !department || selectedIsCurrent}
          data-testid="move-confirm"
        >
          {saving ? 'Moving…' : 'Confirm'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
