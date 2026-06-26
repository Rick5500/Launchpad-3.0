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
            Browse all active work orders and explore detailed records.
          </Typography>
        </Box>
        <Button variant="contained" onClick={() => navigate('/work-orders/new')}>
          New Work Order
        </Button>
      </Box>
      <Card sx={{ bgcolor: '#1f2a38' }}>
        <CardContent>
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>WO #</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell>Customer</TableCell>
                  <TableCell>Department</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Due</TableCell>
                  <TableCell>View</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {workOrders.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
                      No work orders found.
                    </TableCell>
                  </TableRow>
                ) : (
                  workOrders.map((order) => (
                    <TableRow
                      key={order.id}
                      hover
                      sx={{ cursor: 'pointer', '&:hover': { bgcolor: '#16212d' } }}
                      onClick={() => navigate(`/work-orders/${order.id}`)}
                    >
                      <TableCell>{order.external_id || `WO-${order.id}`}</TableCell>
                      <TableCell>{order.description}</TableCell>
                      <TableCell>{order.customer_name}</TableCell>
                      <TableCell>{order.department}</TableCell>
                      <TableCell>{order.status}</TableCell>
                      <TableCell>{order.due_date || '-'}</TableCell>
                      <TableCell>
                        <Tooltip title="View details">
                          <IconButton onClick={(e) => { e.stopPropagation(); navigate(`/work-orders/${order.id}`); }}>
                            <VisibilityIcon />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Box>
  );
}
