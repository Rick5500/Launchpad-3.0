import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import { authFetch } from '../api';

const TYPES = ['text', 'select', 'number', 'checkbox', 'textarea'];

function blankField(index) {
  return {
    key: '',
    label: '',
    type: 'text',
    required: false,
    is_active: true,
    sort_order: index * 10,
    options: [],
  };
}

function copyFields(fields) {
  return (fields || []).map((field) => ({
    key: field.key || '',
    label: field.label || '',
    type: field.type || 'text',
    required: Boolean(field.required),
    is_active: field.is_active !== false,
    sort_order: field.sort_order ?? 0,
    options: (field.options || []).map((option) => (
      typeof option === 'string'
        ? { value: option, active: true }
        : { value: option.value || '', active: option.active !== false }
    )),
  }));
}

export default function ServiceFieldsEditor({ service, open, onClose }) {
  const [fields, setFields] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !service) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    setNotice('');
    authFetch(`/api/services/${service.id}/fields`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load fields');
        return body;
      })
      .then((body) => {
        if (!cancelled) setFields(copyFields(body.fields));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load fields');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, service]);

  function updateField(index, patch) {
    setFields((current) => current.map((field, fieldIndex) => (
      fieldIndex === index ? { ...field, ...patch } : field
    )));
  }

  function updateOption(fieldIndex, optionIndex, patch) {
    setFields((current) => current.map((field, index) => {
      if (index !== fieldIndex) return field;
      const options = field.options.map((option, inner) => (
        inner === optionIndex ? { ...option, ...patch } : option
      ));
      return { ...field, options };
    }));
  }

  async function save() {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await authFetch(`/api/services/${service.id}/fields`, {
        method: 'PUT',
        body: JSON.stringify({
          fields: fields.map((field) => ({
            ...field,
            options: field.type === 'select' ? field.options.filter((option) => option.value.trim()) : [],
          })),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to save fields');
      setFields(copyFields(body.fields));
      setNotice('Line item fields saved.');
    } catch (err) {
      setError(err.message || 'Unable to save fields');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Line item fields — {service?.name}</DialogTitle>
      <DialogContent>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          These fields appear when a customer selects this service. Turning an option off keeps it on orders that already used it.
        </Typography>
        {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
        {notice ? <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert> : null}
        {loading ? <Typography>Loading fields...</Typography> : null}
        <Box sx={{ display: 'grid', gap: 2 }}>
          {fields.map((field, index) => (
            <Box key={`${field.key}-${index}`} sx={{ border: '1px solid #E2E8F0', borderRadius: 1, p: 1.5 }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 140px' }, gap: 1 }}>
                <TextField label="Label" size="small" value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} />
                <TextField label="Key" size="small" value={field.key} onChange={(event) => updateField(index, { key: event.target.value })} helperText="Lowercase letters, digits, underscores" />
                <TextField select label="Type" size="small" value={field.type} onChange={(event) => updateField(index, { type: event.target.value })}>
                  {TYPES.map((type) => <MenuItem key={type} value={type}>{type}</MenuItem>)}
                </TextField>
                <TextField label="Sort" size="small" type="number" value={field.sort_order} onChange={(event) => updateField(index, { sort_order: Number(event.target.value) })} />
                <FormControlLabel control={<Switch checked={field.required} onChange={(event) => updateField(index, { required: event.target.checked })} />} label="Required" />
                <FormControlLabel control={<Switch checked={field.is_active} onChange={(event) => updateField(index, { is_active: event.target.checked })} />} label="Active" />
              </Box>
              {field.type === 'select' ? (
                <Box sx={{ mt: 1, display: 'grid', gap: 0.75 }}>
                  {field.options.map((option, optionIndex) => (
                    <Box key={`${option.value}-${optionIndex}`} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                      <TextField
                        size="small"
                        label={`Option ${optionIndex + 1}`}
                        value={option.value}
                        onChange={(event) => updateOption(index, optionIndex, { value: event.target.value })}
                        sx={{ flex: 1 }}
                      />
                      <FormControlLabel
                        control={<Checkbox checked={option.active} onChange={(event) => updateOption(index, optionIndex, { active: event.target.checked })} />}
                        label="Active"
                      />
                    </Box>
                  ))}
                  <Button
                    size="small"
                    startIcon={<AddIcon />}
                    onClick={() => updateField(index, { options: [...field.options, { value: '', active: true }] })}
                  >
                    Add option
                  </Button>
                </Box>
              ) : null}
            </Box>
          ))}
        </Box>
        <Button sx={{ mt: 2 }} startIcon={<AddIcon />} onClick={() => setFields((current) => [...current, blankField(current.length + 1)])}>
          Add field
        </Button>
      </DialogContent>
      <DialogActions>
        <IconButton aria-label="Close" onClick={onClose}><CloseIcon /></IconButton>
        <Button onClick={onClose}>Close</Button>
        <Button variant="contained" disabled={saving || loading} onClick={save}>{saving ? 'Saving...' : 'Save fields'}</Button>
      </DialogActions>
    </Dialog>
  );
}
