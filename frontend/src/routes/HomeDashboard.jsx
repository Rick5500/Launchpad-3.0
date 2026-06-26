import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  CircularProgress,
  Grid,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tab,
  Tabs,
  Typography,
  Divider,
} from '@mui/material';
import { authFetch } from '../api';

const metricCards = [
  { key: 'totalWorkOrders', label: 'Total Work Orders' },
  { key: 'activeWorkOrders', label: 'Active Work Orders' },
  { key: 'productionBoardItems', label: 'Production Board Items' },
  { key: 'customers', label: 'Customers' },
  { key: 'pendingDeliveries', label: 'Pending Deliveries' },
];

const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export default function HomeDashboard() {
  const [summary, setSummary] = useState(null);
  const [workOrders, setWorkOrders] = useState([]);
  const [activeTab, setActiveTab] = useState('All');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      authFetch('/api/dashboard').then((res) => {
        if (!res.ok) throw new Error('Unable to load dashboard summary');
        return res.json();
      }),
      authFetch('/api/workorders').then((res) => {
        if (!res.ok) throw new Error('Unable to load work orders');
        return res.json();
      }),
    ])
      .then(([summaryData, workOrdersData]) => {
        setSummary(summaryData);
        setWorkOrders(workOrdersData);
      })
      .catch(() => {
        setSummary({});
        setWorkOrders([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const departments = useMemo(() => {
    const names = new Set(['All']);
    workOrders.forEach((workOrder) => {
      if (workOrder.department) names.add(workOrder.department);
    });
    return Array.from(names);
  }, [workOrders]);

  const filteredOrders = useMemo(() => {
    if (activeTab === 'All') return workOrders;
    return workOrders.filter((order) => order.department === activeTab);
  }, [activeTab, workOrders]);

  if (loading) {
    return (
      <Box sx={{ p: 4, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Home Dashboard
      </Typography>
      <Typography variant="body1" color="text.secondary" gutterBottom>
        Real-time insights across work orders, production, delivery, and department performance.
      </Typography>

      <Grid container spacing={3}>
        {metricCards.map((card) => (
          <Grid key={card.key} xs={12} sm={6} md={4}>
            <Card sx={{ minHeight: 130, bgcolor: '#1f2a38' }}>
              <CardContent>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  {card.label}
                </Typography>
                <Typography variant="h4">
                  {summary && typeof summary[card.key] === 'number' ? summary[card.key] : 0}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Grid container spacing={3} sx={{ mt: 3 }}>
        <Grid item xs={12} md={8}>
          <Card sx={{ bgcolor: '#1f2a38' }}>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
                <Box>
                  <Typography variant="h6">Active Work Orders</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Current work order activity by department.
                  </Typography>
                </Box>
                <Tabs
                  value={activeTab}
                  onChange={(_, value) => setActiveTab(value)}
                  variant="scrollable"
                  scrollButtons="auto"
                  allowScrollButtonsMobile
                >
                  {departments.map((department) => (
                    <Tab key={department} label={department} value={department} />
                  ))}
                </Tabs>
              </Box>

              <Divider sx={{ my: 2, borderColor: '#334455' }} />

              <TableContainer component={Paper} sx={{ bgcolor: '#14202b' }}>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ color: '#90caf9' }}>WO #</TableCell>
                      <TableCell sx={{ color: '#90caf9' }}>Customer</TableCell>
                      <TableCell sx={{ color: '#90caf9' }}>Department</TableCell>
                      <TableCell sx={{ color: '#90caf9' }}>Status</TableCell>
                      <TableCell sx={{ color: '#90caf9' }}>Due Date</TableCell>
                      <TableCell sx={{ color: '#90caf9' }}>Qty</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredOrders.length ? (
                      filteredOrders.map((order) => (
                        <TableRow key={order.id} sx={{ '&:hover': { bgcolor: '#1a2531' } }}>
                          <TableCell>{order.external_id || `WO-${order.id}`}</TableCell>
                          <TableCell>{order.customer_name || 'Unknown'}</TableCell>
                          <TableCell>{order.department || 'General'}</TableCell>
                          <TableCell>{order.status}</TableCell>
                          <TableCell>{order.due_date ? formatter.format(new Date(order.due_date)) : '-'}</TableCell>
                          <TableCell>{order.quantity}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={6} sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
                          No active work orders for this department.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={4}>
          <Grid container spacing={3}>
            <Grid item xs={12}>
              <Card sx={{ bgcolor: '#1f2a38' }}>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Department Summary
                  </Typography>
                  <Box sx={{ display: 'grid', gap: 1 }}>
                    {summary?.departmentSummary?.length ? (
                      summary.departmentSummary.map((dept) => (
                        <Box key={dept.department} sx={{ display: 'flex', justifyContent: 'space-between' }}>
                          <Typography>{dept.department}</Typography>
                          <Typography color="text.secondary">{dept.count}</Typography>
                        </Box>
                      ))
                    ) : (
                      <Typography color="text.secondary">No department data yet.</Typography>
                    )}
                  </Box>
                </CardContent>
              </Card>
            </Grid>

            <Grid item xs={12}>
              <Card sx={{ bgcolor: '#1f2a38' }}>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Quick Actions
                  </Typography>
                  <Box sx={{ display: 'grid', gap: 1 }}>
                    <Typography variant="body2" color="text.secondary">
                      • View current production board items.
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      • Track pending deliveries and due-time rules.
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      • Manage customers and admin workflows.
                    </Typography>
                  </Box>
                </CardContent>
              </Card>
            </Grid>

            <Grid item xs={12}>
              <Card sx={{ bgcolor: '#1f2a38' }}>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Performance Widget
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Active orders: {summary?.activeWorkOrders ?? 0}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Pending delivery: {summary?.pendingDeliveries ?? 0}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
          </Grid>
        </Grid>
      </Grid>
    </Box>
  );
}
