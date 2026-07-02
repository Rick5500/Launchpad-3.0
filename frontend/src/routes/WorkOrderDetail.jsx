import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { 
  Box, Button, Card, CardContent, Chip, Grid, Typography, Tabs, Tab, Divider, Paper, 
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Alert, AlertTitle,
  LinearProgress, Dialog, DialogTitle, DialogContent, DialogActions
} from '@mui/material';
import { Timeline, TimelineItem, TimelineOppositeContent, TimelineSeparator, TimelineConnector, TimelineDot, TimelineContent } from '@mui/lab';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import SectionCard from '../components/SectionCard';
import { authFetch } from '../api';

const tabs = ['Overview', 'Timeline', 'Specifications', 'Attachments', 'Activity History', 'Routing', 'Notes'];

// Department status colors based on status
function getDepartmentStatusColor(status) {
  const colors = {
    'Not Required': '#666666',
    'Waiting': '#ff9800',
    'Proof': '#2196f3',
    'In Progress': '#2196f3',
    'On Hold': '#f44336',
    'Complete': '#4caf50'
  };
  return colors[status] || '#90caf9';
}

function getEventTypeLabel(eventType) {
  const labels = {
    'stage_change': 'Stage Updated',
    'department_change': 'Department Updated',
    'barcode_scan': 'Barcode Scanned',
    'stage_change+department_change': 'Stage & Department Updated',
    'note': 'Note Added',
  };
  return labels[eventType] || eventType;
}

function getEventTypeColor(eventType) {
  const colors = {
    'stage_change': '#42a5f5',
    'department_change': '#66bb6a',
    'barcode_scan': '#ffb300',
    'stage_change+department_change': '#ab47bc',
    'note': '#90caf9',
  };
  return colors[eventType] || '#90caf9';
}

function formatDateTime(isoString) {
  if (!isoString) return '-';
  const date = new Date(isoString);
  return date.toLocaleString();
}

function formatDate(isoString) {
  if (!isoString) return '-';
  const date = new Date(isoString);
  return date.toLocaleDateString();
}

// Check if all required departments are complete
function isReadyForQC(workOrder) {
  if (!workOrder.department_statuses || workOrder.department_statuses.length === 0) {
    return false; // No departments required
  }
  return workOrder.department_statuses.every(dept => 
    dept.status === 'Not Required' || dept.status === 'Complete'
  );
}

// Calculate job health percentage
function calculateJobHealth(workOrder) {
  if (!workOrder.department_statuses || workOrder.department_statuses.length === 0) {
    return 100;
  }
  const complete = workOrder.department_statuses.filter(d => d.status === 'Complete' || d.status === 'Not Required').length;
  return Math.round((complete / workOrder.department_statuses.length) * 100);
}

function getPacketStatusColor(status) {
  const colors = {
    'Waiting': '#ff9800',
    'In Progress': '#2196f3',
    'In QC': '#7e57c2',
    'On Hold': '#f44336',
    'Complete': '#4caf50',
    'No Longer Required': '#607d8b'
  };
  return colors[status] || '#90caf9';
}

function getTabContent(tab, workOrder, events, eventsLoading, onMarkDeliveryComplete, deliveryDialogOpen, setDeliveryDialogOpen) {
  switch (tab) {
    case 'Overview':
      return (
        <Box sx={{ p: 2 }}>
          {/* Header Section */}
          <Box sx={{ mb: 3, pb: 2, borderBottom: '1px solid #334455' }}>
            <Grid container spacing={3} alignItems="flex-start">
              <Grid item xs={12} sm={6}>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#e0e0e0' }}>
                    Work Order #{workOrder.external_id || workOrder.id}
                  </Typography>
                  <Typography variant="body2" sx={{ color: '#999', mt: 0.5 }}>
                    Customer: {workOrder.customer_name || '-'}
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={12} sm={6}>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                  <Chip 
                    label={workOrder.status} 
                    sx={{ bgcolor: '#334455', color: '#e0e0e0' }} 
                  />
                  <Chip 
                    label={`Priority: ${workOrder.priority || 'Normal'}`}
                    sx={{ bgcolor: '#334455', color: '#e0e0e0' }} 
                  />
                </Box>
              </Grid>
            </Grid>
          </Box>

          {/* Job Health & QC Status Alert */}
          {isReadyForQC(workOrder) && (
            <Alert severity="success" sx={{ mb: 3, bgcolor: '#1e5e20', borderColor: '#4caf50' }}>
              <AlertTitle sx={{ fontWeight: 'bold' }}>Ready for QC</AlertTitle>
              All required departments have completed their work.
            </Alert>
          )}

          {/* Key Information Grid */}
          <Grid container spacing={2} sx={{ mb: 4 }}>
            <Grid item xs={12} sm={6} md={3}>
              <Box sx={{ bgcolor: '#0f1822', p: 2, border: '1px solid #334455', borderRadius: 1 }}>
                <Typography variant="caption" sx={{ color: '#999' }}>Due Date & Time</Typography>
                <Typography variant="body2" sx={{ color: '#e0e0e0', fontWeight: 'bold', mt: 0.5 }}>
                  {workOrder.due_date ? formatDate(workOrder.due_date) : '-'}
                </Typography>
              </Box>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Box sx={{ bgcolor: '#0f1822', p: 2, border: '1px solid #334455', borderRadius: 1 }}>
                <Typography variant="caption" sx={{ color: '#999' }}>Delivery Method</Typography>
                <Typography variant="body2" sx={{ color: '#e0e0e0', fontWeight: 'bold', mt: 0.5 }}>
                  {workOrder.delivery_method ? workOrder.delivery_method.replace('_', ' ').toUpperCase() : '-'}
                </Typography>
              </Box>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Box sx={{ bgcolor: '#0f1822', p: 2, border: '1px solid #334455', borderRadius: 1 }}>
                <Typography variant="caption" sx={{ color: '#999' }}>Requested Delivery/Pickup</Typography>
                <Typography variant="body2" sx={{ color: '#e0e0e0', fontWeight: 'bold', mt: 0.5 }}>
                  {workOrder.requested_delivery_time ? formatDateTime(workOrder.requested_delivery_time) : '-'}
                </Typography>
              </Box>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Box sx={{ bgcolor: '#0f1822', p: 2, border: '1px solid #334455', borderRadius: 1 }}>
                <Typography variant="caption" sx={{ color: '#999' }}>QC Status</Typography>
                <Typography variant="body2" sx={{ color: '#e0e0e0', fontWeight: 'bold', mt: 0.5 }}>
                  {workOrder.matrix_state?.qc_status || 'Not Required'}
                </Typography>
              </Box>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Box sx={{ bgcolor: '#0f1822', p: 2, border: '1px solid #334455', borderRadius: 1 }}>
                <Typography variant="caption" sx={{ color: '#999' }}>Delivery Type</Typography>
                <Typography variant="body2" sx={{ color: '#e0e0e0', fontWeight: 'bold', mt: 0.5 }}>
                  {workOrder.matrix_state?.delivery_type ? workOrder.matrix_state.delivery_type.replace('_', ' ').toUpperCase() : 'Not Set'}
                </Typography>
              </Box>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Box sx={{ bgcolor: '#0f1822', p: 2, border: '1px solid #334455', borderRadius: 1 }}>
                <Typography variant="caption" sx={{ color: '#999' }}>Delivery Status</Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 0.5 }}>
                  {workOrder.delivery_status === 'Ready' ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography variant="body2" sx={{ color: '#2196F3', fontWeight: 'bold' }}>
                        Ready for {workOrder.delivery_method === 'will_call' ? 'Will Call' : 'Delivery'}
                      </Typography>
                      <Button
                        size="small"
                        variant="contained"
                        color="success"
                        onClick={() => setDeliveryDialogOpen(true)}
                        sx={{ ml: 1 }}
                      >
                        Mark Complete
                      </Button>
                    </Box>
                  ) : workOrder.delivery_status === 'Complete' ? (
                    <Typography variant="body2" sx={{ color: '#66BB6A', fontWeight: 'bold' }}>
                      ✓ Complete
                    </Typography>
                  ) : (
                    <Typography variant="body2" sx={{ color: '#BDBDBD', fontWeight: 'bold' }}>
                      Pending
                    </Typography>
                  )}
                </Box>
              </Box>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Box sx={{ bgcolor: '#0f1822', p: 2, border: '1px solid #334455', borderRadius: 1 }}>
                <Typography variant="caption" sx={{ color: '#999' }}>Quantity</Typography>
                <Typography variant="body2" sx={{ color: '#e0e0e0', fontWeight: 'bold', mt: 0.5 }}>
                  {workOrder.quantity || '-'}
                </Typography>
              </Box>
            </Grid>
          </Grid>

          {/* Job Health */}
          <Box sx={{ mb: 4 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="subtitle2" sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>
                Job Health
              </Typography>
              <Typography variant="body2" sx={{ color: '#4caf50', fontWeight: 'bold' }}>
                {calculateJobHealth(workOrder)}%
              </Typography>
            </Box>
            <LinearProgress 
              variant="determinate" 
              value={calculateJobHealth(workOrder)}
              sx={{ 
                height: 8, 
                borderRadius: 1,
                backgroundColor: '#1f2a38',
                '& .MuiLinearProgress-bar': {
                  backgroundColor: calculateJobHealth(workOrder) === 100 ? '#4caf50' : '#2196f3'
                }
              }}
            />
          </Box>

          {/* Product Line Items Section */}
          {workOrder.line_items && workOrder.line_items.length > 0 && (
            <Box sx={{ mb: 4 }}>
              <Typography variant="h6" sx={{ fontWeight: 'bold', mb: 2, color: '#e0e0e0' }}>
                Products
              </Typography>
              <TableContainer component={Paper} sx={{ bgcolor: '#0f1822', border: '1px solid #334455' }}>
                <Table size="small">
                  <TableHead sx={{ bgcolor: '#1f2a38' }}>
                    <TableRow>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>Product</TableCell>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }} align="right">Qty</TableCell>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>Departments</TableCell>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>Notes</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {workOrder.line_items.map((item, index) => (
                      <TableRow key={index} sx={{ '&:hover': { bgcolor: '#1f2a38' } }}>
                        <TableCell sx={{ color: '#e0e0e0' }}>
                          {item.product_name || 'Unknown'}
                        </TableCell>
                        <TableCell sx={{ color: '#e0e0e0' }} align="right">
                          {item.quantity || 1}
                        </TableCell>
                        <TableCell sx={{ color: '#e0e0e0' }}>
                          {item.required_departments && item.required_departments.length > 0 ? (
                            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                              {item.required_departments.map((dept) => (
                                <Chip
                                  key={dept.id}
                                  label={dept.department_name || '-'}
                                  size="small"
                                  sx={{ 
                                    bgcolor: dept.color || '#334455', 
                                    color: '#fff',
                                    height: 24
                                  }}
                                />
                              ))}
                            </Box>
                          ) : (
                            <Typography variant="caption" sx={{ color: '#666' }}>-</Typography>
                          )}
                        </TableCell>
                        <TableCell sx={{ color: item.notes ? '#e0e0e0' : '#666', fontSize: '0.875rem' }}>
                          {item.notes || '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}

          {/* Department Status Section */}
          {workOrder.department_statuses && workOrder.department_statuses.length > 0 && (
            <Box sx={{ mb: 4 }}>
              <Typography variant="h6" sx={{ fontWeight: 'bold', mb: 2, color: '#e0e0e0' }}>
                Department Status
              </Typography>
              <Grid container spacing={1}>
                {workOrder.department_statuses.map((dept) => (
                  <Grid item xs={12} sm={6} md={4} key={dept.id}>
                    <Box sx={{ 
                      bgcolor: '#0f1822', 
                      p: 2, 
                      border: '1px solid #334455', 
                      borderRadius: 1,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}>
                      <Typography variant="body2" sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>
                        {dept.department_name || '-'}
                      </Typography>
                      <Chip
                        label={dept.status}
                        size="small"
                        sx={{
                          bgcolor: getDepartmentStatusColor(dept.status),
                          color: '#fff',
                          fontWeight: 'bold'
                        }}
                      />
                    </Box>
                  </Grid>
                ))}
              </Grid>
            </Box>
          )}

          {/* Department Packets Section */}
          {workOrder.department_packets && workOrder.department_packets.length > 0 && (
            <Box sx={{ mb: 4 }}>
              <Typography variant="h6" sx={{ fontWeight: 'bold', mb: 2, color: '#e0e0e0' }}>
                Department Packets
              </Typography>
              <TableContainer component={Paper} sx={{ bgcolor: '#0f1822', border: '1px solid #334455' }}>
                <Table size="small">
                  <TableHead sx={{ bgcolor: '#1f2a38' }}>
                    <TableRow>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>Department</TableCell>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>Packet #</TableCell>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>Status</TableCell>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>Barcode</TableCell>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>QC Received</TableCell>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>Completed</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {workOrder.department_packets.map((packet) => (
                      <TableRow key={packet.id} sx={{ '&:hover': { bgcolor: '#1f2a38' } }}>
                        <TableCell sx={{ color: '#e0e0e0' }}>
                          {packet.department_name || '-'}
                        </TableCell>
                        <TableCell sx={{ color: '#4caf50', fontFamily: 'monospace' }}>
                          {packet.packet_number}
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={packet.status || 'Waiting'}
                            size="small"
                            sx={{
                              bgcolor: getPacketStatusColor(packet.status),
                              color: '#fff',
                              fontWeight: 'bold'
                            }}
                          />
                        </TableCell>
                        <TableCell sx={{ color: '#e0e0e0', fontFamily: 'monospace' }}>
                          {packet.barcode_value || '-'}
                        </TableCell>
                        <TableCell sx={{ color: packet.received_in_qc_at ? '#e0e0e0' : '#666' }}>
                          {packet.received_in_qc_at ? formatDateTime(packet.received_in_qc_at) : '-'}
                        </TableCell>
                        <TableCell sx={{ color: packet.completed_at ? '#e0e0e0' : '#666' }}>
                          {packet.completed_at ? formatDateTime(packet.completed_at) : '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}

          {/* Barcode Section */}
          <Box sx={{ mb: 4 }}>
            <Typography variant="subtitle2" sx={{ color: '#e0e0e0', fontWeight: 'bold', mb: 1 }}>
              Barcode
            </Typography>
            <Box sx={{ 
              bgcolor: '#0f1822', 
              p: 2, 
              border: '1px solid #334455', 
              borderRadius: 1,
              fontFamily: 'monospace',
              color: '#4caf50',
              fontSize: '0.9rem',
              wordBreak: 'break-all'
            }}>
              {workOrder.latest_barcode?.scanned_value || '(No barcode scanned)'}
            </Box>
            {workOrder.latest_barcode?.event_time && (
              <Typography variant="caption" sx={{ color: '#999', mt: 1, display: 'block' }}>
                Last scanned: {formatDateTime(workOrder.latest_barcode.event_time)}
              </Typography>
            )}
          </Box>

          {/* Notes Section */}
          {workOrder.notes && (
            <Box sx={{ mb: 4 }}>
              <Typography variant="subtitle2" sx={{ color: '#e0e0e0', fontWeight: 'bold', mb: 1 }}>
                Notes
              </Typography>
              <Box sx={{ 
                bgcolor: '#0f1822', 
                p: 2, 
                border: '1px solid #334455', 
                borderRadius: 1,
                color: '#e0e0e0',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}>
                {workOrder.notes}
              </Box>
            </Box>
          )}

          {/* Timeline Summary Section */}
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" sx={{ color: '#e0e0e0', fontWeight: 'bold', mb: 1 }}>
              Timeline Summary
            </Typography>
            <Grid container spacing={1}>
              <Grid item xs={12} sm={6}>
                <Box sx={{ bgcolor: '#0f1822', p: 1.5, border: '1px solid #334455', borderRadius: 1 }}>
                  <Typography variant="caption" sx={{ color: '#999' }}>Created</Typography>
                  <Typography variant="body2" sx={{ color: '#e0e0e0' }}>
                    {formatDateTime(workOrder.created_at)}
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={12} sm={6}>
                <Box sx={{ bgcolor: '#0f1822', p: 1.5, border: '1px solid #334455', borderRadius: 1 }}>
                  <Typography variant="caption" sx={{ color: '#999' }}>Last Updated</Typography>
                  <Typography variant="body2" sx={{ color: '#e0e0e0' }}>
                    {workOrder.updated_at ? formatDateTime(workOrder.updated_at) : 'Not updated'}
                  </Typography>
                </Box>
              </Grid>
            </Grid>
          </Box>
        </Box>
      );
      if (eventsLoading) {
        return <Typography color="text.secondary">Loading events...</Typography>;
      }
      if (!events || events.length === 0) {
        return <Typography color="text.secondary">No events yet. Events will appear as the work order progresses through production stages.</Typography>;
      }
      return (
        <Box>
          <Typography gutterBottom sx={{ mb: 3 }}>
            Work order timeline showing all stage changes, department updates, and barcode scans in chronological order.
          </Typography>
          <Timeline position="alternate">
            {events.map((event, index) => (
              <TimelineItem key={event.id}>
                <TimelineOppositeContent color="text.secondary" sx={{ fontSize: '0.875rem' }}>
                  {formatDateTime(event.created_at)}
                </TimelineOppositeContent>
                <TimelineSeparator>
                  <TimelineDot sx={{ bgcolor: getEventTypeColor(event.event_type) }} />
                  {index < events.length - 1 && <TimelineConnector />}
                </TimelineSeparator>
                <TimelineContent>
                  <Paper elevation={0} sx={{ p: 2, bgcolor: '#14202b', border: '1px solid #334455' }}>
                    <Typography variant="h6" sx={{ color: getEventTypeColor(event.event_type) }}>
                      {getEventTypeLabel(event.event_type)}
                    </Typography>
                    {event.from_stage_name && (
                      <Typography variant="body2" color="text.secondary">
                        Stage: {event.from_stage_name} → {event.to_stage_name}
                      </Typography>
                    )}
                    {event.from_department_name && (
                      <Typography variant="body2" color="text.secondary">
                        Department: {event.from_department_name} → {event.to_department_name}
                      </Typography>
                    )}
                    {event.note && (
                      <Typography variant="body2" sx={{ mt: 1 }}>
                        {event.note}
                      </Typography>
                    )}
                  </Paper>
                </TimelineContent>
              </TimelineItem>
            ))}
          </Timeline>
        </Box>
      );
    case 'Specifications':
      return <Typography color="text.secondary">Specification details will be added here when available.</Typography>;
    case 'Attachments':
      return <Typography color="text.secondary">No attachments yet. This section will support file uploads in the future.</Typography>;
    case 'Activity History':
      return <Typography color="text.secondary">History events will appear here once the activity log is implemented.</Typography>;
    case 'Routing':
      return <Typography color="text.secondary">Routing details and production lane path will appear here.</Typography>;
    case 'Notes':
      return <Typography color="text.secondary">Internal notes and comments will be displayed here.</Typography>;
    default:
      return null;
  }
}

export default function WorkOrderDetail() {
  const navigate = useNavigate();
  const { id } = useParams();

  const [workOrder, setWorkOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('Overview');
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [deliveryDialogOpen, setDeliveryDialogOpen] = useState(false);
  const [markingDeliveryComplete, setMarkingDeliveryComplete] = useState(false);

  useEffect(() => {
    setLoading(true);
    authFetch(`/api/workorders/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error('Work order not found');
        return res.json();
      })
      .then((data) => setWorkOrder(data))
      .catch((err) => setError(err.message || 'Unable to load work order'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    setEventsLoading(true);
    authFetch(`/api/workorders/${id}/events`)
      .then((res) => {
        if (!res.ok) throw new Error('Unable to load events');
        return res.json();
      })
      .then((data) => setEvents(data || []))
      .catch((err) => console.error('Error loading events:', err))
      .finally(() => setEventsLoading(false));
  }, [id]);

  const handleMarkDeliveryComplete = async () => {
    setMarkingDeliveryComplete(true);
    try {
      const response = await authFetch(`/api/matrix/work-orders/${id}/delivery-complete`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        const errorData = await response.json();
        setError(errorData.error || 'Failed to mark delivery complete');
        setDeliveryDialogOpen(false);
        return;
      }

      setDeliveryDialogOpen(false);
      // Reload work order to get updated status
      authFetch(`/api/workorders/${id}`)
        .then(res => res.json())
        .then(data => setWorkOrder(data))
        .catch(err => setError(err.message || 'Failed to reload work order'));
    } catch (err) {
      setError(err.message || 'Failed to mark delivery complete');
      setDeliveryDialogOpen(false);
    } finally {
      setMarkingDeliveryComplete(false);
    }
  };

  const handleCancelDeliveryDialog = () => {
    setDeliveryDialogOpen(false);
    setMarkingDeliveryComplete(false);
  };

  if (loading) return <LoadingState message="Loading work order details..." />;
  if (error) return <ErrorState message={error} />;
  if (!workOrder) return <ErrorState message="Work order record is missing." />;

  return (
    <Box sx={{ p: 3 }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 2, mb: 2 }}>
        <Box>
          <Typography variant="h4" gutterBottom>
            Work Order Detail
          </Typography>
          <Typography color="text.secondary">
            Detailed information for work order {workOrder.external_id || `#${workOrder.id}`}
          </Typography>
        </Box>
        <Button variant="contained" onClick={() => navigate(`/work-orders/${id}/edit`)}>
          Edit Work Order
        </Button>
      </Box>

      <Box sx={{ mt: 2, mb: 3 }}>
        <Chip label={workOrder.status} color="primary" sx={{ mr: 1 }} />
        <Chip label={workOrder.department} sx={{ mr: 1 }} />
        <Chip label={`Qty: ${workOrder.quantity}`} />
      </Box>

      <Card sx={{ bgcolor: '#1f2a38' }}>
        <CardContent>
          <Tabs value={activeTab} onChange={(_, value) => setActiveTab(value)} indicatorColor="primary" textColor="inherit" variant="scrollable" scrollButtons="auto">
            {tabs.map((tab) => (
              <Tab key={tab} label={tab} value={tab} />
            ))}
          </Tabs>
          <Divider sx={{ borderColor: '#334455', my: 2 }} />
          {getTabContent(activeTab, workOrder, events, eventsLoading, handleMarkDeliveryComplete, deliveryDialogOpen, setDeliveryDialogOpen)}
        </CardContent>
      </Card>

      <Dialog
        open={deliveryDialogOpen}
        onClose={handleCancelDeliveryDialog}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 'bold' }}>
          Mark Delivery Complete
        </DialogTitle>
        <DialogContent sx={{ mt: 2 }}>
          <Box>
            <Box sx={{ mb: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                <span style={{ fontWeight: 'bold' }}>Work Order:</span>
                <span>#{workOrder.external_id || workOrder.id}</span>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                <span style={{ fontWeight: 'bold' }}>Customer:</span>
                <span>{workOrder.customer_name || '—'}</span>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 'bold' }}>Type:</span>
                <span>
                  {workOrder.delivery_method === 'will_call' ? 'Will Call' : 'Delivery'}
                </span>
              </Box>
            </Box>
            <Box sx={{ p: 1.5, backgroundColor: '#f5f5f5', borderRadius: 1, color: '#333' }}>
              Mark this {workOrder.delivery_method === 'will_call' ? 'will call' : 'delivery'} as complete? 
              This will finalize the work order.
            </Box>
          </Box>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button
            onClick={handleCancelDeliveryDialog}
            disabled={markingDeliveryComplete}
          >
            Cancel
          </Button>
          <Button
            onClick={handleMarkDeliveryComplete}
            variant="contained"
            color="success"
            disabled={markingDeliveryComplete}
          >
            {markingDeliveryComplete ? 'Marking Complete...' : 'Mark Complete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
