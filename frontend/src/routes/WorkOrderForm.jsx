import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box,
  Button,
  Card,
  CardContent,
  Grid,
  MenuItem,
  TextField,
  Typography,
  Alert,
  Autocomplete,
} from '@mui/material';
import LoadingState from '../components/LoadingState';
import { authFetch } from '../api';
import { useAuth } from '../context/AuthContext';
import { canonicalWorkOrderStatus } from '../workOrderStatus';

const statusOptions = ['open', 'in-progress', 'completed', 'on-hold'];
const OPERATOR_CUSTOMER_MESSAGE = 'New customers must be created by an administrator.';

function normalizeStatus(status) {
  return canonicalWorkOrderStatus(status) || 'open';
}

function findCustomer(customers, name) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return null;
  return customers.find((customer) => {
    if (!customer) return false;
    const displayName = (customer.display_name || '').toLowerCase();
    const username = (customer.username || '').toLowerCase();
    return displayName === needle || username === needle;
  }) || null;
}

const defaultValues = {
  external_id: '',
  customer_id: '',
  description: '',
  quantity: '',
  status: 'open',
  department: 'General',
  specifications: '',
  start_date: '',
  due_date: '',
  production_line: '',
  routing_instructions: '',
  attachments: '',
  notes: '',
};

function formatDateInput(value) {
  if (!value) return ''; 
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export default function WorkOrderForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const isOperator = user?.role === 'operator';
  const [values, setValues] = useState(defaultValues);
  const [customers, setCustomers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [customerInput, setCustomerInput] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [issuedLogin, setIssuedLogin] = useState(null);
  const [customerTouched, setCustomerTouched] = useState(false);

  useEffect(() => {
    setLoading(true);
    const customerUrl = isAdmin ? '/api/customers' : '/api/customers/lookup';
    const fetchCustomers = (isAdmin || isOperator)
      ? authFetch(customerUrl).then((res) => {
          if (!res.ok) throw new Error('Unable to load customers');
          return res.json();
        })
      : Promise.resolve([]);

    const fetchDepartments = authFetch('/api/departments').then((res) => {
      if (!res.ok) throw new Error('Unable to load departments');
      return res.json();
    });

    const fetchWorkOrder = id
      ? authFetch(`/api/workorders/${id}`).then((res) => {
          if (!res.ok) throw new Error('Unable to load work order');
          return res.json();
        })
      : Promise.resolve(null);

    Promise.all([fetchCustomers, fetchDepartments, fetchWorkOrder])
      .then(([customerData, departmentData, workOrderData]) => {
        setCustomers(customerData);
        setDepartments(departmentData.filter((dept) => dept.is_active !== 0));
        if (workOrderData) {
          setValues({
            external_id: workOrderData.external_id || '',
            customer_id: workOrderData.customer_id != null ? String(workOrderData.customer_id) : '',
            description: workOrderData.description || '',
            quantity: workOrderData.quantity != null ? String(workOrderData.quantity) : '',
            status: normalizeStatus(workOrderData.status),
            department: workOrderData.department || 'General',
            specifications: workOrderData.specifications || '',
            start_date: formatDateInput(workOrderData.start_date),
            due_date: formatDateInput(workOrderData.due_date),
            production_line: workOrderData.production_line || '',
            routing_instructions: workOrderData.routing_instructions || '',
            attachments: workOrderData.attachments || '',
            notes: workOrderData.notes || '',
          });

          // pre-fill customer input / selection
          const found = customerData.find((c) => Number(c.id) === Number(workOrderData.customer_id));
          if (found) {
            setSelectedCustomer(found);
            setCustomerInput(found.display_name || found.username || '');
          } else {
            setSelectedCustomer(null);
            setCustomerInput(workOrderData.customer_name || '');
          }
        } else {
          setValues(defaultValues);
          setSelectedCustomer(null);
          setCustomerInput('');
        }
      })
      .catch((err) => setError(err.message || 'Unable to load form data'))
      .finally(() => setLoading(false));
  }, [id, isAdmin, isOperator]);

  const handleChange = (field) => (event) => {
    setValues((current) => ({ ...current, [field]: event.target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setMessage('');
    setSaving(true);

    let customerId = null;
    let createdLogin = null;

    if (isAdmin) {
      const customerName = (customerInput || '').trim();
      if (!customerName) {
        setError('Customer name is required');
        setSaving(false);
        return;
      }

      const existing = customers.find((c) => {
        if (!c) return false;
        const dn = (c.display_name || '').toLowerCase();
        const un = (c.username || '').toLowerCase();
        return dn === customerName.toLowerCase() || un === customerName.toLowerCase();
      });

      try {
        if (existing) {
          customerId = existing.id;
        } else {
          const resp = await authFetch('/api/customers', { method: 'POST', body: JSON.stringify({ display_name: customerName }) });
          const body = await resp.json();
          if (!resp.ok) throw new Error(body.error || 'Failed to create customer');
          customerId = body.id;
          if (body.password) {
            createdLogin = { username: body.username, password: body.password };
          }
          setCustomers((cur) => (cur ? [...cur, { id: customerId, display_name: customerName, username: body.username || customerName }] : [{ id: customerId, display_name: customerName, username: body.username || customerName }]));
        }
      } catch (err) {
        setError(err.message || 'Unable to create customer');
        setSaving(false);
        return;
      }
    } else {
      const existing = findCustomer(customers, customerInput);
      if (!existing) {
        setCustomerTouched(true);
        setError(`No matching customer. ${OPERATOR_CUSTOMER_MESSAGE}`);
        setSaving(false);
        return;
      }
      customerId = existing.id;
    }

    const payload = {
      ...values,
      customer_id: Number(customerId),
      quantity: Number(values.quantity),
    };

    try {
      const response = await authFetch(`/api/workorders${id ? `/${id}` : ''}`, {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Failed to save work order');
      if (createdLogin) {
        setIssuedLogin({ ...createdLogin, workOrderId: body.id });
        setMessage('Work order saved. Copy the customer password below before leaving this page.');
        return;
      }
      setMessage('Work order saved successfully. Redirecting...');
      navigate(`/work-orders/${body.id}`);
    } catch (err) {
      setError(err.message || 'Unable to save work order');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState message="Loading work order form..." />;

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        {id ? 'Edit Work Order' : 'Create New Work Order'}
      </Typography>
      <Typography color="text.secondary" gutterBottom>
        {id
          ? 'Update existing work order details and operational instructions.'
          : 'Enter the work order details and schedule that will be used by production and delivery teams.'}
      </Typography>
      <Card sx={{ bgcolor: '#1f2a38' }}>
        <CardContent>
          <Box component="form" onSubmit={handleSubmit} sx={{ display: 'grid', gap: 3 }}>
            {error && <Alert severity="error">{error}</Alert>}
            {message && <Alert severity="success">{message}</Alert>}
            {issuedLogin && (
              <Alert
                severity="info"
                action={(
                  <Button color="inherit" size="small" type="button" onClick={() => navigate(`/work-orders/${issuedLogin.workOrderId}`)}>
                    Continue
                  </Button>
                )}
              >
                Customer {issuedLogin.username} was created. Temporary password (shown once): {issuedLogin.password}
              </Alert>
            )}
            <Grid container spacing={2}>
              <Grid item xs={12} md={6}>
                <TextField
                  label="Work Order #"
                  value={values.external_id}
                  onChange={handleChange('external_id')}
                  fullWidth
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                />
              </Grid>
              <Grid item xs={12} md={6}>
                <Autocomplete
                  freeSolo={isAdmin}
                  options={customers}
                  getOptionLabel={(option) => (typeof option === 'string' ? option : option.display_name || option.username || '')}
                  isOptionEqualToValue={(option, value) => option.id === value.id}
                  value={selectedCustomer}
                  inputValue={customerInput}
                  onInputChange={(_, newInput) => {
                    setCustomerInput(newInput);
                  }}
                  onChange={(_, newValue) => {
                    if (typeof newValue === 'string') {
                      setSelectedCustomer(isAdmin ? null : findCustomer(customers, newValue));
                      setCustomerInput(newValue);
                    } else if (newValue && newValue.inputValue) {
                      setSelectedCustomer(null);
                      setCustomerInput(newValue.inputValue);
                    } else {
                      setSelectedCustomer(newValue);
                      setCustomerInput(newValue ? newValue.display_name || newValue.username || '' : '');
                    }
                  }}
                  onBlur={() => setCustomerTouched(true)}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Customer"
                      fullWidth
                      variant="filled"
                      error={!isAdmin && customerTouched && Boolean(customerInput.trim()) && !findCustomer(customers, customerInput)}
                      helperText={isAdmin
                        ? 'Choose an existing customer or type a new name to create one.'
                        : customers.length
                          ? `Select an existing customer. ${OPERATOR_CUSTOMER_MESSAGE}`
                          : `No customers are available. ${OPERATOR_CUSTOMER_MESSAGE}`}
                      InputProps={{ ...params.InputProps, sx: { bgcolor: '#121d27' } }}
                    />
                  )}
                />
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField
                  label="Status"
                  select
                  value={values.status}
                  onChange={handleChange('status')}
                  fullWidth
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                >
                  {statusOptions.map((status) => (
                    <MenuItem key={status} value={status}>
                      {status}
                    </MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField
                  label="Department"
                  select
                  value={values.department}
                  onChange={handleChange('department')}
                  fullWidth
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                >
                  {departments.length ? departments.map((department) => (
                    <MenuItem key={department.id} value={department.name}>
                      {department.name}
                    </MenuItem>
                  )) : (
                    <MenuItem value="General">General</MenuItem>
                  )}
                </TextField>
              </Grid>
              <Grid item xs={12} md={8}>
                <TextField
                  label="Description"
                  value={values.description}
                  onChange={handleChange('description')}
                  fullWidth
                  multiline
                  rows={3}
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                />
              </Grid>
              <Grid item xs={12} md={4}>
                <TextField
                  label="Quantity"
                  value={values.quantity}
                  onChange={handleChange('quantity')}
                  type="number"
                  fullWidth
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                />
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField
                  label="Start Date"
                  type="date"
                  value={values.start_date}
                  onChange={handleChange('start_date')}
                  fullWidth
                  InputLabelProps={{ shrink: true }}
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                />
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField
                  label="Due Date"
                  type="date"
                  value={values.due_date}
                  onChange={handleChange('due_date')}
                  fullWidth
                  InputLabelProps={{ shrink: true }}
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                />
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField
                  label="Production Line"
                  value={values.production_line}
                  onChange={handleChange('production_line')}
                  fullWidth
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                />
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField
                  label="Attachments"
                  value={values.attachments}
                  onChange={handleChange('attachments')}
                  fullWidth
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                />
              </Grid>
              <Grid item xs={12}>
                <TextField
                  label="Specifications"
                  value={values.specifications}
                  onChange={handleChange('specifications')}
                  fullWidth
                  multiline
                  rows={3}
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                />
              </Grid>
              <Grid item xs={12}>
                <TextField
                  label="Routing Instructions"
                  value={values.routing_instructions}
                  onChange={handleChange('routing_instructions')}
                  fullWidth
                  multiline
                  rows={2}
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                />
              </Grid>
              <Grid item xs={12}>
                <TextField
                  label="Notes"
                  value={values.notes}
                  onChange={handleChange('notes')}
                  fullWidth
                  multiline
                  rows={3}
                  variant="filled"
                  InputProps={{ sx: { bgcolor: '#121d27' } }}
                />
              </Grid>
            </Grid>

            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Button variant="outlined" onClick={() => navigate('/work-orders')}>
                Cancel
              </Button>
              <Button type="submit" variant="contained" disabled={saving}>
                {saving ? 'Saving…' : id ? 'Update Work Order' : 'Create Work Order'}
              </Button>
            </Box>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
