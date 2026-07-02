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
  const [departments, setDepartments] = useState([]);
  const [productionMetrics, setProductionMetrics] = useState(null);
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
      authFetch('/api/departments').then((res) => {
        if (!res.ok) throw new Error('Unable to load departments');
        return res.json();
      }),
      authFetch('/api/production-board').then((res) => {
        if (!res.ok) throw new Error('Unable to load production board metrics');
        return res.json();
      }),
    ])
      .then(([summaryData, workOrdersData, departmentData, boardData]) => {
        setSummary(summaryData);
        setWorkOrders(workOrdersData);
        setDepartments((departmentData || []).filter((dept) => dept.is_active !== 0));
        setProductionMetrics(boardData?.metrics || null);
      })
      .catch(() => {
        setSummary({});
        setWorkOrders([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const departmentTabs = useMemo(() => {
    const names = new Set(['All']);
    departments.forEach((dept) => {
      names.add(dept.name);
    });
    return Array.from(names);
  }, [departments]);

  const filteredOrders = useMemo(() => {
    // Filter to show only active orders (not completed)
    const activeOrders = workOrders.filter(order => order.delivery_status !== 'Complete');
    
    if (activeTab === 'All') return activeOrders;
    return activeOrders.filter((order) => {
      if (order.department_statuses && order.department_statuses.length > 0) {
        return order.department_statuses.some((dept) => dept.name === activeTab && dept.status !== 'Not Required');
      }
      return false;
    });
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
          <Grid item key={card.key} xs={12} sm={6} md={4}>
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
        <Grid item xs={12}>
          <Card sx={{ bgcolor: '#1f2a38' }}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Production Snapshot
              </Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6} md={3}>
                  <Box sx={{ p: 2, borderRadius: 2, bgcolor: '#14202b' }}>
                    <Typography variant="subtitle2" color="text.secondary">Work Orders by Stage</Typography>
                    <Typography variant="h5">{productionMetrics?.workOrdersByStage?.length || 0}</Typography>
                  </Box>
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <Box sx={{ p: 2, borderRadius: 2, bgcolor: '#14202b' }}>
                    <Typography variant="subtitle2" color="text.secondary">Rush Orders</Typography>
                    <Typography variant="h5">{productionMetrics?.rushOrders ?? 0}</Typography>
                  </Box>
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <Box sx={{ p: 2, borderRadius: 2, bgcolor: '#14202b' }}>
                    <Typography variant="subtitle2" color="text.secondary">Late Orders</Typography>
                    <Typography variant="h5">{productionMetrics?.lateOrders ?? 0}</Typography>
                  </Box>
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <Box sx={{ p: 2, borderRadius: 2, bgcolor: '#14202b' }}>
                    <Typography variant="subtitle2" color="text.secondary">Today&apos;s Shipments</Typography>
                    <Typography variant="h5">{productionMetrics?.todaysShipments ?? 0}</Typography>
                  </Box>
                </Grid>
              </Grid>
            </CardContent>
          </Card>
        </Grid>
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
                  {departmentTabs.map((department) => (
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
                      <TableCell sx={{ color: '#90caf9' }}>Dept Status</TableCell>
                      <TableCell sx={{ color: '#90caf9' }}>QC Status</TableCell>
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
                          <TableCell>
                            {order.department_statuses && order.department_statuses.length > 0 ? (
                              order.department_statuses
                                .filter((dept) => dept.status !== 'Not Required')
                                .map((dept) => dept.name)
                                .join(', ') || '—'
                            ) : (
                              '—'
                            )}
                          </TableCell>
                          <TableCell>{order.qc_status || 'Not Required'}</TableCell>
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
                    Department Activity
                  </Typography>
                  <Box sx={{ display: 'grid', gap: 1 }}>
                    {summary?.departmentSummary?.length ? (
                      summary.departmentSummary.map((dept) => (
                        <Box key={dept.name} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', p: 1, bgcolor: '#14202b', borderRadius: 1 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            {dept.color && (
                              <Box
                                sx={{
                                  width: 12,
                                  height: 12,
                                  borderRadius: '2px',
                                  backgroundColor: dept.color,
                                }}
                              />
                            )}
                            <Typography variant="body2">{dept.name}</Typography>
                          </Box>
                          <Typography variant="body2" fontWeight="bold" sx={{ color: '#4caf50' }}>
                            {dept.count}
                          </Typography>
                        </Box>
                      ))
                    ) : (
                      <Typography color="text.secondary">No department activity yet.</Typography>
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
