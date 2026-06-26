import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Chip,
  Grid,
  Paper,
  Stack,
  Typography,
  Divider,
  Alert,
} from '@mui/material';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import SectionCard from '../components/SectionCard';
import { authFetch } from '../api';

const priorityColors = {
  Low: 'default',
  Normal: 'info',
  High: 'warning',
  Rush: 'error',
};

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function ProductionBoard() {
  const navigate = useNavigate();
  const [stages, setStages] = useState([]);
  const [workOrders, setWorkOrders] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeId, setActiveId] = useState(null);

  const loadBoard = () => {
    setLoading(true);
    authFetch('/api/production-board')
      .then((res) => {
        if (!res.ok) throw new Error('Unable to load production board');
        return res.json();
      })
      .then((payload) => {
        setStages(payload.stages || []);
        setWorkOrders(payload.workOrders || []);
        setMetrics(payload.metrics || null);
        setError('');
      })
      .catch((err) => setError(err.message || 'Unable to load production board'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadBoard();
  }, []);

  const groupedOrders = useMemo(() => {
    const groups = new Map();
    stages.forEach((stage) => groups.set(stage.id, []));
    workOrders.forEach((order) => {
      const stageId = order.stage_id ?? stages[0]?.id;
      if (!groups.has(stageId)) {
        groups.set(stageId, []);
      }
      groups.get(stageId).push(order);
    });
    return groups;
  }, [stages, workOrders]);

  const updateStage = async (orderId, stageId) => {
    setActiveId(orderId);
    try {
      const response = await authFetch(`/api/workorders/${orderId}/stage`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage_id: stageId }),
      });
      if (!response.ok) throw new Error('Failed to update stage');
      await loadBoard();
    } catch (err) {
      setError(err.message || 'Failed to update work order stage');
    } finally {
      setActiveId(null);
    }
  };

  const handleDrop = async (stageId) => {
    if (!activeId) return;
    await updateStage(activeId, stageId);
  };

  if (loading) return <LoadingState message="Loading production board..." />;
  if (error && !workOrders.length) return <ErrorState message={error} />;

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Production Board
      </Typography>
      <Typography color="text.secondary" gutterBottom>
        Track work orders through each production stage with real-time updates.
      </Typography>

      <SectionCard title="Production Snapshot" subtitle="Live counts for production flow and shipping readiness.">
        <Grid container spacing={2}>
          <Grid item xs={12} sm={6} md={3}>
            <Paper sx={{ p: 2, bgcolor: '#14202b' }}>
              <Typography variant="subtitle2" color="text.secondary">Work Orders by Stage</Typography>
              <Typography variant="h5">{metrics?.workOrdersByStage?.length || 0}</Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Paper sx={{ p: 2, bgcolor: '#14202b' }}>
              <Typography variant="subtitle2" color="text.secondary">Rush Orders</Typography>
              <Typography variant="h5">{metrics?.rushOrders ?? 0}</Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Paper sx={{ p: 2, bgcolor: '#14202b' }}>
              <Typography variant="subtitle2" color="text.secondary">Late Orders</Typography>
              <Typography variant="h5">{metrics?.lateOrders ?? 0}</Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Paper sx={{ p: 2, bgcolor: '#14202b' }}>
              <Typography variant="subtitle2" color="text.secondary">Today's Shipments</Typography>
              <Typography variant="h5">{metrics?.todaysShipments ?? 0}</Typography>
            </Paper>
          </Grid>
        </Grid>
      </SectionCard>

      {error && <Alert severity="warning" sx={{ mb: 2 }}>{error}</Alert>}

      <Grid container spacing={2} sx={{ alignItems: 'flex-start' }}>
        {stages.map((stage) => (
          <Grid item xs={12} md={6} lg={4} key={stage.id}>
            <Paper sx={{ bgcolor: '#1f2a38', p: 2, minHeight: 480, border: '1px solid #2f3b4a' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                <Box>
                  <Typography variant="h6">{stage.name}</Typography>
                  <Typography variant="body2" color="text.secondary">{(groupedOrders.get(stage.id) || []).length} orders</Typography>
                </Box>
                <Chip label={stage.name} size="small" sx={{ bgcolor: stage.color || '#90caf9', color: '#fff' }} />
              </Box>
              <Divider sx={{ mb: 2, borderColor: '#334455' }} />
              <Stack spacing={1.5} onDragOver={(event) => event.preventDefault()} onDrop={() => handleDrop(stage.id)}>
                {(groupedOrders.get(stage.id) || []).length ? (
                  groupedOrders.get(stage.id).map((order) => (
                    <Card
                      key={order.id}
                      draggable
                      onDragStart={() => setActiveId(order.id)}
                      onClick={() => navigate(`/work-orders/${order.id}`)}
                      sx={{
                        bgcolor: order.priority === 'Rush' ? '#3f1f1f' : '#14202b',
                        border: order.priority === 'Rush' ? '1px solid #ff8a80' : '1px solid #2f3b4a',
                        cursor: 'pointer',
                      }}
                    >
                      <CardContent sx={{ py: 1.5 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                          <Typography variant="subtitle2">{order.external_id || `WO-${order.id}`}</Typography>
                          <DragIndicatorIcon fontSize="small" color="action" />
                        </Box>
                        <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                          {order.customer_name || order.customer_username || 'Unknown customer'}
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                          {order.description || 'No description provided.'}
                        </Typography>
                        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                          <Chip label={order.priority || 'Normal'} size="small" color={priorityColors[order.priority] || 'default'} />
                          <Chip label={order.department || 'General'} size="small" variant="outlined" />
                        </Stack>
                        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                          Due: {formatDate(order.due_date)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" display="block">
                          Assigned: {order.assigned_user_name || order.assigned_user_username || 'Unassigned'}
                        </Typography>
                      </CardContent>
                    </Card>
                  ))
                ) : (
                  <Box sx={{ p: 2, border: '1px dashed #334455', borderRadius: 2, color: 'text.secondary', textAlign: 'center' }}>
                    Drop work orders here
                  </Box>
                )}
              </Stack>
            </Paper>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
