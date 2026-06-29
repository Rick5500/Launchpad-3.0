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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
  IconButton,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import LoadingState from '../components/LoadingState';
import { authFetch } from '../api';

const statusOptions = ['open', 'in-progress', 'complete', 'on-hold'];

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
  const [values, setValues] = useState(defaultValues);
  const [customers, setCustomers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [products, setProducts] = useState([]);
  const [customerInput, setCustomerInput] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [lineItems, setLineItems] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [productQuantity, setProductQuantity] = useState('1');
  const [productNotes, setProductNotes] = useState('');
  const [selectedProductDepartments, setSelectedProductDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    setLoading(true);
    const fetchCustomers = authFetch('/api/customers').then((res) => {
      if (!res.ok) throw new Error('Unable to load customers');
      return res.json();
    });

    const fetchDepartments = authFetch('/api/departments').then((res) => {
      if (!res.ok) throw new Error('Unable to load departments');
      return res.json();
    });

    const fetchProducts = authFetch('/api/products').then((res) => {
      if (!res.ok) throw new Error('Unable to load products');
      return res.json();
    });

    const fetchWorkOrder = id
      ? authFetch(`/api/workorders/${id}`).then((res) => {
          if (!res.ok) throw new Error('Unable to load work order');
          return res.json();
        })
      : Promise.resolve(null);

    Promise.all([fetchCustomers, fetchDepartments, fetchProducts, fetchWorkOrder])
      .then(([customerData, departmentData, productData, workOrderData]) => {
        setCustomers(customerData);
        setDepartments(departmentData.filter((dept) => dept.is_active !== 0));
        setProducts(productData);
        if (workOrderData) {
          setValues({
            external_id: workOrderData.external_id || '',
            description: workOrderData.description || '',
            quantity: workOrderData.quantity != null ? String(workOrderData.quantity) : '',
            status: workOrderData.status || 'open',
            department: workOrderData.department || 'General',
            specifications: workOrderData.specifications || '',
            start_date: formatDateInput(workOrderData.start_date),
            due_date: formatDateInput(workOrderData.due_date),
            production_line: workOrderData.production_line || '',
            routing_instructions: workOrderData.routing_instructions || '',
            attachments: workOrderData.attachments || '',
            notes: workOrderData.notes || '',
          });

          // Load line items if they exist
          if (workOrderData.line_items && Array.isArray(workOrderData.line_items)) {
            setLineItems(workOrderData.line_items);
          }

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
  }, [id]);

  const handleChange = (field) => (event) => {
    setValues((current) => ({ ...current, [field]: event.target.value }));
  };

  const handleProductSelect = async (product) => {
    setSelectedProduct(product);
    if (product) {
      try {
        const res = await authFetch(`/api/products/${product.id}/required-departments`);
        if (res.ok) {
          const depts = await res.json();
          setSelectedProductDepartments(depts);
        }
      } catch (err) {
        console.error('Error fetching departments:', err);
        setSelectedProductDepartments([]);
      }
    } else {
      setSelectedProductDepartments([]);
    }
  };

  const handleAddLineItem = () => {
    if (!selectedProduct) {
      setError('Please select a product');
      return;
    }
    const newLineItem = {
      product_id: selectedProduct.id,
      product_name: selectedProduct.name,
      quantity: Number(productQuantity) || 1,
      notes: productNotes,
      required_departments: selectedProductDepartments,
    };
    setLineItems([...lineItems, newLineItem]);
    setSelectedProduct(null);
    setProductQuantity('1');
    setProductNotes('');
    setSelectedProductDepartments([]);
  };

  const handleRemoveLineItem = (index) => {
    setLineItems(lineItems.filter((_, i) => i !== index));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setMessage('');
    setSaving(true);

    // validate customer input
    const customerName = (customerInput || '').trim();
    if (!customerName) {
      setError('Customer name is required');
      setSaving(false);
      return;
    }

    let customerId = null;
    // check existing customer match (by display_name or username)
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
        // create new customer
        const resp = await authFetch('/api/customers', { method: 'POST', body: JSON.stringify({ display_name: customerName }) });
        const body = await resp.json();
        if (!resp.ok) throw new Error(body.error || 'Failed to create customer');
        customerId = body.id;
        // refresh customers list locally
        setCustomers((cur) => (cur ? [...cur, { id: customerId, display_name: customerName, username: body.username || customerName }] : [{ id: customerId, display_name: customerName, username: body.username || customerName }]));
      }
    } catch (err) {
      setError(err.message || 'Unable to create customer');
      setSaving(false);
      return;
    }

    const payload = {
      ...values,
      customer_id: Number(customerId),
      quantity: Number(values.quantity),
      line_items: lineItems,
    };

    try {
      const response = await authFetch(`/api/workorders${id ? `/${id}` : ''}`, {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Failed to save work order');
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
                  freeSolo
                  options={customers}
                  getOptionLabel={(option) => (typeof option === 'string' ? option : option.display_name || option.username || '')}
                  value={selectedCustomer}
                  inputValue={customerInput}
                  onInputChange={(_, newInput) => {
                    setCustomerInput(newInput);
                  }}
                  onChange={(_, newValue) => {
                    if (typeof newValue === 'string') {
                      setSelectedCustomer(null);
                      setCustomerInput(newValue);
                    } else if (newValue && newValue.inputValue) {
                      setSelectedCustomer(null);
                      setCustomerInput(newValue.inputValue);
                    } else {
                      setSelectedCustomer(newValue);
                      setCustomerInput(newValue ? newValue.display_name || newValue.username || '' : '');
                    }
                  }}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Customer"
                      fullWidth
                      variant="filled"
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

              {/* Product Line Items Section */}
              <Grid item xs={12}>
                <Typography variant="h6" sx={{ mb: 2, mt: 2 }}>
                  Product Line Items
                </Typography>
                <Card sx={{ bgcolor: '#0f1419', p: 2, mb: 2 }}>
                  <Grid container spacing={2}>
                    <Grid item xs={12} md={6}>
                      <Autocomplete
                        options={products}
                        getOptionLabel={(option) => option.name || ''}
                        value={selectedProduct}
                        onChange={(_, value) => handleProductSelect(value)}
                        renderInput={(params) => (
                          <TextField
                            {...params}
                            label="Select Product"
                            variant="filled"
                            InputProps={{ ...params.InputProps, sx: { bgcolor: '#121d27' } }}
                          />
                        )}
                      />
                    </Grid>
                    <Grid item xs={12} md={3}>
                      <TextField
                        label="Quantity"
                        type="number"
                        value={productQuantity}
                        onChange={(e) => setProductQuantity(e.target.value)}
                        fullWidth
                        variant="filled"
                        InputProps={{ sx: { bgcolor: '#121d27' } }}
                      />
                    </Grid>
                    <Grid item xs={12} md={3}>
                      <Button
                        variant="contained"
                        onClick={handleAddLineItem}
                        fullWidth
                        sx={{ height: '56px' }}
                      >
                        Add Product
                      </Button>
                    </Grid>
                    <Grid item xs={12}>
                      <TextField
                        label="Notes (optional)"
                        value={productNotes}
                        onChange={(e) => setProductNotes(e.target.value)}
                        fullWidth
                        multiline
                        rows={2}
                        variant="filled"
                        InputProps={{ sx: { bgcolor: '#121d27' } }}
                      />
                    </Grid>

                    {selectedProduct && selectedProductDepartments.length > 0 && (
                      <Grid item xs={12}>
                        <Typography variant="subtitle2" sx={{ mb: 1 }}>
                          Required Departments for this Product:
                        </Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                          {selectedProductDepartments.map((dept) => (
                            <Chip
                              key={dept.department_id}
                              label={dept.department_name}
                              color="primary"
                              variant="outlined"
                            />
                          ))}
                        </Box>
                      </Grid>
                    )}
                  </Grid>
                </Card>

                {lineItems.length > 0 && (
                  <TableContainer component={Paper} sx={{ bgcolor: '#1f2a38' }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow sx={{ bgcolor: '#0f1419' }}>
                          <TableCell>Product</TableCell>
                          <TableCell align="right">Qty</TableCell>
                          <TableCell>Departments</TableCell>
                          <TableCell align="center">Action</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {lineItems.map((item, index) => (
                          <TableRow key={index}>
                            <TableCell>{item.product_name}</TableCell>
                            <TableCell align="right">{item.quantity}</TableCell>
                            <TableCell>
                              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                                {item.required_departments && item.required_departments.length > 0 ? (
                                  item.required_departments.map((dept) => (
                                    <Chip
                                      key={dept.department_id}
                                      label={dept.department_name}
                                      size="small"
                                      variant="outlined"
                                    />
                                  ))
                                ) : (
                                  <Typography variant="caption">None</Typography>
                                )}
                              </Box>
                            </TableCell>
                            <TableCell align="center">
                              <IconButton
                                size="small"
                                onClick={() => handleRemoveLineItem(index)}
                                color="error"
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}
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
