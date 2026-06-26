import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  FormControlLabel,
  Grid,
  IconButton,
  MenuItem,
  Paper,
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
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { authFetch } from '../api';

const emptyForm = {
  name: '',
  description: '',
  color: '#90caf9',
  icon: '',
  sort_order: '0',
  is_active: true,
};

export default function DepartmentsAdmin() {
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);

  const loadDepartments = () => {
    setLoading(true);
    authFetch('/api/departments')
      .then((res) => {
        if (!res.ok) throw new Error('Unable to load departments');
        return res.json();
      })
      .then((data) => setDepartments(data || []))
      .catch(() => setError('Unable to load departments.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadDepartments();
  }, []);

  const activeDepartments = useMemo(() => departments.filter((dept) => dept.is_active !== 0), [departments]);
  const inactiveDepartments = useMemo(() => departments.filter((dept) => dept.is_active === 0), [departments]);

  const handleChange = (field) => (event) => {
    const value = field === 'is_active' ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [field]: value }));
  };

  const resetForm = () => {
    setEditingId(null);
    setForm(emptyForm);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setSaving(true);

    const payload = {
      ...form,
      sort_order: Number(form.sort_order),
      is_active: Boolean(form.is_active),
    };

    try {
      const response = await authFetch(`/api/departments${editingId ? `/${editingId}` : ''}`, {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to save department');
      setForm(emptyForm);
      setEditingId(null);
      loadDepartments();
    } catch (err) {
      setError(err.message || 'Unable to save department');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (department) => {
    setEditingId(department.id);
    setForm({
      name: department.name || '',
      description: department.description || '',
      color: department.color || '#90caf9',
      icon: department.icon || '',
      sort_order: String(department.sort_order ?? 0),
      is_active: Boolean(department.is_active),
    });
  };

  const toggleActive = async (department) => {
    setError('');
    try {
      const response = await authFetch(`/api/departments/${department.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...department, is_active: !Boolean(department.is_active) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to update department');
      loadDepartments();
    } catch (err) {
      setError(err.message || 'Unable to update department');
    }
  };

  const moveDepartment = async (department, direction) => {
    setError('');
    const nextSortOrder = Number(department.sort_order ?? 0) + direction;
    try {
      const response = await authFetch(`/api/departments/${department.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...department, sort_order: nextSortOrder }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to update sort order');
      loadDepartments();
    } catch (err) {
      setError(err.message || 'Unable to update sort order');
    }
  };

  const removeDepartment = async (department) => {
    setError('');
    try {
      const response = await authFetch(`/api/departments/${department.id}`, { method: 'DELETE' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to deactivate department');
      loadDepartments();
    } catch (err) {
      setError(err.message || 'Unable to deactivate department');
    }
  };

  if (loading) return <LoadingState message="Loading departments..." />;
  if (error && !departments.length) return <ErrorState message={error} />;

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Department Administration
      </Typography>
      <Typography color="text.secondary" gutterBottom>
        Manage department definitions, activation state, and ordering for the dashboard and work-order workflows.
      </Typography>

      <Grid container spacing={3}>
        <Grid item xs={12} md={4}>
          <Card sx={{ bgcolor: '#1f2a38' }}>
            <CardContent>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                <Typography variant="h6">{editingId ? 'Edit Department' : 'Add Department'}</Typography>
                {editingId && (
                  <Button variant="outlined" size="small" onClick={resetForm}>
                    Cancel
                  </Button>
                )}
              </Box>
              {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
              <Box component="form" onSubmit={handleSubmit} sx={{ display: 'grid', gap: 2 }}>
                <TextField
                  label="Name"
                  value={form.name}
                  onChange={handleChange('name')}
                  fullWidth
                  variant="filled"
                  required
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                />
                <TextField
                  label="Description"
                  value={form.description}
                  onChange={handleChange('description')}
                  fullWidth
                  multiline
                  rows={3}
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                />
                <Grid container spacing={2}>
                  <Grid item xs={6}>
                    <TextField
                      label="Color"
                      value={form.color}
                      onChange={handleChange('color')}
                      fullWidth
                      variant="filled"
                      InputProps={{ sx: { bgcolor: '#121d27' } }}
                    />
                  </Grid>
                  <Grid item xs={6}>
                    <TextField
                      label="Icon"
                      value={form.icon}
                      onChange={handleChange('icon')}
                      fullWidth
                      variant="filled"
                      InputProps={{ sx: { bgcolor: '#121d27' } }}
                    />
                  </Grid>
                </Grid>
                <TextField
                  label="Sort Order"
                  type="number"
                  value={form.sort_order}
                  onChange={handleChange('sort_order')}
                  fullWidth
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                />
                <FormControlLabel
                  control={<Switch checked={Boolean(form.is_active)} onChange={handleChange('is_active')} />}
                  label={form.is_active ? 'Active' : 'Inactive'}
                />
                <Button type="submit" variant="contained" startIcon={<AddIcon />} disabled={saving}>
                  {saving ? 'Saving…' : editingId ? 'Update Department' : 'Create Department'}
                </Button>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={8}>
          <Card sx={{ bgcolor: '#1f2a38' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Department List
              </Typography>
              {departments.length === 0 ? (
                <Typography color="text.secondary">No departments have been created yet.</Typography>
              ) : (
                <TableContainer component={Paper} sx={{ bgcolor: '#14202b' }}>
                  <Table>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ color: '#90caf9' }}>Department</TableCell>
                        <TableCell sx={{ color: '#90caf9' }}>Status</TableCell>
                        <TableCell sx={{ color: '#90caf9' }}>Sort</TableCell>
                        <TableCell sx={{ color: '#90caf9' }}>Actions</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {departments.map((department) => (
                        <TableRow key={department.id}>
                          <TableCell>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: department.color || '#90caf9' }} />
                              <Box>
                                <Typography>{department.name}</Typography>
                                <Typography variant="body2" color="text.secondary">
                                  {department.description || 'No description'}
                                </Typography>
                              </Box>
                            </Box>
                          </TableCell>
                          <TableCell>
                            <Chip label={department.is_active ? 'Active' : 'Inactive'} color={department.is_active ? 'success' : 'default'} size="small" />
                          </TableCell>
                          <TableCell>{department.sort_order ?? 0}</TableCell>
                          <TableCell>
                            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                              <IconButton size="small" onClick={() => handleEdit(department)}><EditIcon /></IconButton>
                              <IconButton size="small" onClick={() => toggleActive(department)}>{department.is_active ? <DeleteIcon /> : <AddIcon />}</IconButton>
                              <IconButton size="small" onClick={() => moveDepartment(department, -1)}><ArrowUpwardIcon /></IconButton>
                              <IconButton size="small" onClick={() => moveDepartment(department, 1)}><ArrowDownwardIcon /></IconButton>
                            </Box>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
              <Divider sx={{ my: 2, borderColor: '#334455' }} />
              <Typography variant="body2" color="text.secondary">
                Active departments: {activeDepartments.length} • Inactive departments: {inactiveDepartments.length}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
