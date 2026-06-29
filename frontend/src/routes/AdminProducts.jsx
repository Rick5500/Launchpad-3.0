import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  FormControlLabel,
  Checkbox,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Alert,
  CircularProgress,
  Chip,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import { authFetch } from '../api';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';

export default function AdminProducts() {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openDialog, setOpenDialog] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    category_id: '',
    proof_required: false,
    qc_required: false,
    barcode_required: false,
    default_turnaround_hours: '',
    required_department_ids: [],
  });

  // Load all data on mount
  useEffect(() => {
    loadAllData();
  }, []);

  const loadAllData = async () => {
    setLoading(true);
    setError('');
    try {
      const [productsRes, categoriesRes, departmentsRes] = await Promise.all([
        authFetch('/api/products'),
        authFetch('/api/products/categories'),
        authFetch('/api/departments'),
      ]);

      if (!productsRes.ok) throw new Error('Failed to load products');
      if (!categoriesRes.ok) throw new Error('Failed to load categories');
      if (!departmentsRes.ok) throw new Error('Failed to load departments');

      const productsData = await productsRes.json();
      const categoriesData = await categoriesRes.json();
      const departmentsData = await departmentsRes.json();

      setProducts(productsData);
      setCategories(categoriesData);
      // Filter out Delivery and Admin departments
      setDepartments(departmentsData.filter(d => !['Delivery', 'Admin'].includes(d.name)));
    } catch (err) {
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenDialog = (product = null) => {
    if (product) {
      setEditingProduct(product);
      setFormData({
        name: product.name,
        description: product.description || '',
        category_id: product.category_id,
        proof_required: product.proof_required === 1,
        qc_required: product.qc_required === 1,
        barcode_required: product.barcode_required === 1,
        default_turnaround_hours: product.default_turnaround_hours || '',
        required_department_ids: (product.required_departments || []).map(d => d.department_id),
      });
    } else {
      setEditingProduct(null);
      setFormData({
        name: '',
        description: '',
        category_id: '',
        proof_required: false,
        qc_required: false,
        barcode_required: false,
        default_turnaround_hours: '',
        required_department_ids: [],
      });
    }
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
    setEditingProduct(null);
  };

  const handleInputChange = (event) => {
    const { name, value, type, checked } = event.target;
    setFormData({
      ...formData,
      [name]: type === 'checkbox' ? checked : value,
    });
  };

  const handleDepartmentToggle = (deptId) => {
    setFormData(prev => {
      const newDepts = prev.required_department_ids.includes(deptId)
        ? prev.required_department_ids.filter(id => id !== deptId)
        : [...prev.required_department_ids, deptId];
      return { ...prev, required_department_ids: newDepts };
    });
  };

  const handleSaveProduct = async () => {
    if (!formData.name || !formData.category_id) {
      setError('Name and category are required');
      return;
    }

    try {
      const payload = {
        ...formData,
        default_turnaround_hours: formData.default_turnaround_hours
          ? parseInt(formData.default_turnaround_hours)
          : null,
      };

      const url = editingProduct
        ? `/api/products/${editingProduct.id}`
        : '/api/products';
      const method = editingProduct ? 'PUT' : 'POST';

      const res = await authFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error('Failed to save product');

      setError('');
      handleCloseDialog();
      loadAllData();
    } catch (err) {
      setError(err.message || 'Failed to save product');
    }
  };

  const handleDeleteProduct = async (productId) => {
    if (!window.confirm('Are you sure you want to deactivate this product?')) {
      return;
    }

    try {
      const res = await authFetch(`/api/products/${productId}`, {
        method: 'DELETE',
      });

      if (!res.ok) throw new Error('Failed to deactivate product');

      setError('');
      loadAllData();
    } catch (err) {
      setError(err.message || 'Failed to deactivate product');
    }
  };

  const getCategoryName = (categoryId) => {
    const cat = categories.find(c => c.id === categoryId);
    return cat ? cat.name : '—';
  };

  const getDepartmentName = (deptId) => {
    const dept = departments.find(d => d.id === deptId);
    return dept ? dept.name : '—';
  };

  if (loading) {
    return <LoadingState message="Loading products..." />;
  }

  return (
    <Box sx={{ p: 2 }}>
      <Card>
        <CardHeader
          title="Product Catalog Management"
          subheader="Create and manage products with their configurations"
          action={
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => handleOpenDialog()}
            >
              New Product
            </Button>
          }
        />
        <CardContent>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          {products.length === 0 ? (
            <Alert severity="info">No products created yet. Click "New Product" to get started.</Alert>
          ) : (
            <TableContainer component={Paper} sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow sx={{ backgroundColor: '#f5f5f5' }}>
                    <TableCell sx={{ fontWeight: 'bold' }}>Name</TableCell>
                    <TableCell sx={{ fontWeight: 'bold' }}>Category</TableCell>
                    <TableCell sx={{ fontWeight: 'bold' }} align="center">
                      Proof
                    </TableCell>
                    <TableCell sx={{ fontWeight: 'bold' }} align="center">
                      QC
                    </TableCell>
                    <TableCell sx={{ fontWeight: 'bold' }} align="center">
                      Barcode
                    </TableCell>
                    <TableCell sx={{ fontWeight: 'bold' }}>Turnaround (hrs)</TableCell>
                    <TableCell sx={{ fontWeight: 'bold' }}>Departments</TableCell>
                    <TableCell sx={{ fontWeight: 'bold' }} align="center">
                      Actions
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {products
                    .filter(p => p.is_active === 1)
                    .map((product) => (
                      <TableRow key={product.id}>
                        <TableCell sx={{ fontWeight: 500 }}>{product.name}</TableCell>
                        <TableCell>{product.category_name}</TableCell>
                        <TableCell align="center">
                          {product.proof_required === 1 ? '✓' : '—'}
                        </TableCell>
                        <TableCell align="center">
                          {product.qc_required === 1 ? '✓' : '—'}
                        </TableCell>
                        <TableCell align="center">
                          {product.barcode_required === 1 ? '✓' : '—'}
                        </TableCell>
                        <TableCell>
                          {product.default_turnaround_hours || '—'}
                        </TableCell>
                        <TableCell>
                          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                            {product.required_departments && product.required_departments.length > 0 ? (
                              product.required_departments.map(dept => (
                                <Chip
                                  key={dept.department_id}
                                  label={dept.department_name}
                                  size="small"
                                  variant="outlined"
                                />
                              ))
                            ) : (
                              <span>—</span>
                            )}
                          </Box>
                        </TableCell>
                        <TableCell align="center">
                          <Button
                            size="small"
                            startIcon={<EditIcon />}
                            onClick={() => handleOpenDialog(product)}
                            sx={{ mr: 1 }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="small"
                            color="error"
                            startIcon={<DeleteIcon />}
                            onClick={() => handleDeleteProduct(product.id)}
                          >
                            Remove
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={openDialog} onClose={handleCloseDialog} maxWidth="sm" fullWidth>
        <DialogTitle>
          {editingProduct ? 'Edit Product' : 'Create New Product'}
        </DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <TextField
            fullWidth
            label="Product Name"
            name="name"
            value={formData.name}
            onChange={handleInputChange}
            margin="normal"
            required
          />

          <TextField
            fullWidth
            label="Description"
            name="description"
            value={formData.description}
            onChange={handleInputChange}
            margin="normal"
            multiline
            rows={2}
          />

          <FormControl fullWidth margin="normal" required>
            <InputLabel>Category</InputLabel>
            <Select
              name="category_id"
              value={formData.category_id}
              onChange={handleInputChange}
              label="Category"
            >
              <MenuItem value="">Select a category</MenuItem>
              {categories.map(cat => (
                <MenuItem key={cat.id} value={cat.id}>
                  {cat.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            fullWidth
            label="Default Turnaround Hours"
            name="default_turnaround_hours"
            type="number"
            value={formData.default_turnaround_hours}
            onChange={handleInputChange}
            margin="normal"
          />

          <Box sx={{ mt: 2, mb: 2 }}>
            <FormControlLabel
              control={
                <Checkbox
                  name="proof_required"
                  checked={formData.proof_required}
                  onChange={handleInputChange}
                />
              }
              label="Proof Required"
            />
            <FormControlLabel
              control={
                <Checkbox
                  name="qc_required"
                  checked={formData.qc_required}
                  onChange={handleInputChange}
                />
              }
              label="QC Required"
            />
            <FormControlLabel
              control={
                <Checkbox
                  name="barcode_required"
                  checked={formData.barcode_required}
                  onChange={handleInputChange}
                />
              }
              label="Barcode Required"
            />
          </Box>

          <Box sx={{ mt: 2 }}>
            <strong>Required Departments:</strong>
            <Box sx={{ mt: 1, mb: 2 }}>
              {departments.map(dept => (
                <FormControlLabel
                  key={dept.id}
                  control={
                    <Checkbox
                      checked={formData.required_department_ids.includes(dept.id)}
                      onChange={() => handleDepartmentToggle(dept.id)}
                    />
                  }
                  label={dept.name}
                />
              ))}
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog}>Cancel</Button>
          <Button onClick={handleSaveProduct} variant="contained">
            {editingProduct ? 'Update' : 'Create'} Product
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
