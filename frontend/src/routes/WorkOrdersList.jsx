import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  IconButton,
  Tooltip,
  Chip,
  Paper,
} from '@mui/material';
import VisibilityIcon from '@mui/icons-material/Visibility';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { authFetch } from '../api';

export default function WorkOrdersList() {
  const [workOrders, setWorkOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);
    authFetch('/api/workorders')
      .then((res) => {
        if (!res.ok) throw new Error('Unable to load work orders.');
        return res.json();
      })
      .then((data) => setWorkOrders(data))
      .catch(() => setError('Unable to load work orders.'))
      .finally(() => setLoading(false));
  }, []);

  const formatDate = (dateString) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusColor = (status) => {
    const colors = {
      'Not Required': '#666666',
      'Waiting': '#ff9800',
      'Proof': '#2196f3',
      'In Progress': '#2196f3',
      'On Hold': '#f44336',
      'Complete': '#4caf50'
    };
    return colors[status] || '#90caf9';
  };

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" gutterBottom>
            Work Orders
          </Typography>
          <Typography color="text.secondary">
            Browse all active work orders and operational status.
          </Typography>
        </Box>
        <Button variant="contained" onClick={() => navigate('/work-orders/new')}>
          New Work Order
        </Button>
      </Box>
      <Card sx={{ bgcolor: '#1f2a38' }}>
        <CardContent>
          {workOrders.length === 0 ? (
            <Typography color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
              No active work orders found.
            </Typography>
          ) : (
            <TableContainer component={Paper} sx={{ overflowX: 'auto', backgroundColor: '#0f1822' }}>
              <Table stickyHeader size="small" sx={{ backgroundColor: '#0f1822' }}>
                <TableHead>
                  <TableRow sx={{ backgroundColor: '#1f2a38' }}>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '100px', color: '#ccc', backgroundColor: '#1f2a38' }}>WO #</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '150px', color: '#ccc', backgroundColor: '#1f2a38' }}>Description</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '120px', color: '#ccc', backgroundColor: '#1f2a38' }}>Customer</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '140px', color: '#ccc', backgroundColor: '#1f2a38' }}>Department Status</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '100px', color: '#ccc', backgroundColor: '#1f2a38' }}>QC Status</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '100px', color: '#ccc', backgroundColor: '#1f2a38' }}>Delivery</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '140px', color: '#ccc', backgroundColor: '#1f2a38' }}>Due Date & Time</TableCell>
                    <TableCell sx={{ fontWeight: 'bold', minWidth: '60px', color: '#ccc', backgroundColor: '#1f2a38' }}>View</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {workOrders.map((order) => (
                    <TableRow
                      key={order.id}
                      sx={{
                        cursor: 'pointer',
                        backgroundColor: '#1f2a38',
                        borderLeft: '4px solid #2196f3',
                        '&:hover': { backgroundColor: '#334455' },
                      }}
                    >
                      <TableCell sx={{ fontWeight: 500, color: '#eee' }}>
                        {order.external_id || `#${order.id}`}
                      </TableCell>
                      <TableCell sx={{ color: '#ccc' }}>
                        {order.description || '—'}
                      </TableCell>
                      <TableCell sx={{ color: '#ccc' }}>
                        {order.customer_name || '—'}
                      </TableCell>
                      <TableCell sx={{ color: '#ccc' }}>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                          {order.department_statuses && order.department_statuses.length > 0 ? (
                            order.department_statuses.map((dept) => (
                              <Chip
                                key={dept.id}
                                label={`${dept.name}: ${dept.status}`}
                                size="small"
                                sx={{
                                  backgroundColor: getStatusColor(dept.status),
                                  color: '#fff',
                                  fontWeight: 'bold',
                                  fontSize: '0.7rem'
                                }}
                              />
                            ))
                          ) : (
                            <Typography variant="caption" sx={{ color: '#999' }}>No depts</Typography>
                          )}
                        </Box>
                      </TableCell>
                      <TableCell sx={{ color: '#ccc', fontWeight: 'bold' }}>
                        {order.qc_status || 'Not Required'}
                      </TableCell>
                      <TableCell sx={{ color: '#ccc' }}>
                        {order.delivery_method ? (
                          <Chip
                            label={order.delivery_method.replace('_', ' ').toUpperCase()}
                            size="small"
                            sx={{
                              backgroundColor: order.delivery_method === 'will_call' ? '#ff9800' : '#2196f3',
                              color: '#fff'
                            }}
                          />
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell sx={{ color: '#ccc' }}>
                        {formatDate(order.due_date)}
                      </TableCell>
                      <TableCell>
                        <Tooltip title="View details">
                          <IconButton 
                            size="small"
                            onClick={(e) => { e.stopPropagation(); navigate(`/work-orders/${order.id}`); }}
                            sx={{ color: '#2196f3' }}
                          >
                            <VisibilityIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
