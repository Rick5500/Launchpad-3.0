import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, Button, Card, CardContent, Chip, Grid, Typography, Tabs, Tab, Divider, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow } from '@mui/material';
import { Timeline, TimelineItem, TimelineOppositeContent, TimelineSeparator, TimelineConnector, TimelineDot, TimelineContent } from '@mui/lab';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import SectionCard from '../components/SectionCard';
import { authFetch } from '../api';

const tabs = ['Overview', 'Timeline', 'Specifications', 'Attachments', 'Activity History', 'Routing', 'Notes'];

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

function getTabContent(tab, workOrder, events, eventsLoading) {
  switch (tab) {
    case 'Overview':
      return (
        <Box>
          <Typography gutterBottom>
            This page displays all available work order fields and gives a quick operational summary.
          </Typography>
          <Grid container spacing={2}>
            {Object.entries({
              'Work Order': workOrder.external_id,
              'Status': workOrder.status,
              'Department': workOrder.department,
              'Quantity': workOrder.quantity,
              'Due Date': workOrder.due_date,
              'Customer': workOrder.customer_name,
              'Customer Username': workOrder.customer_username,
              'Created At': workOrder.created_at,
              'Updated At': workOrder.updated_at,
            }).map(([label, value]) => (
              <Grid item xs={12} sm={6} key={label}>
                <SectionCard title={label}>
                  <Typography>{value || '-'}</Typography>
                </SectionCard>
              </Grid>
            ))}
          </Grid>

          {/* Product Line Items Section */}
          {workOrder.line_items && workOrder.line_items.length > 0 && (
            <Box sx={{ mt: 4 }}>
              <Typography variant="h6" gutterBottom sx={{ fontWeight: 'bold' }}>
                Product Line Items
              </Typography>
              <TableContainer component={Paper} sx={{ bgcolor: '#0f1822', border: '1px solid #334455' }}>
                <Table>
                  <TableHead sx={{ bgcolor: '#1f2a38' }}>
                    <TableRow>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>Product</TableCell>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }} align="right">Quantity</TableCell>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>Departments</TableCell>
                      <TableCell sx={{ color: '#e0e0e0', fontWeight: 'bold' }}>Notes</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {workOrder.line_items.map((item, index) => (
                      <TableRow key={index} sx={{ '&:hover': { bgcolor: '#1f2a38' } }}>
                        <TableCell sx={{ color: '#e0e0e0' }}>{item.product_name || 'Unknown Product'}</TableCell>
                        <TableCell sx={{ color: '#e0e0e0' }} align="right">{item.quantity || 1}</TableCell>
                        <TableCell sx={{ color: '#e0e0e0' }}>
                          {item.required_departments && item.required_departments.length > 0 ? (
                            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                              {item.required_departments.map((dept) => (
                                <Chip
                                  key={dept.id}
                                  label={dept.department_name || dept.name}
                                  size="small"
                                  sx={{ bgcolor: '#334455', color: '#e0e0e0' }}
                                />
                              ))}
                            </Box>
                          ) : (
                            <Typography color="text.secondary">-</Typography>
                          )}
                        </TableCell>
                        <TableCell sx={{ color: item.notes ? '#e0e0e0' : '#666' }}>
                          {item.notes || '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}
        </Box>
      );
    case 'Timeline':
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
          {getTabContent(activeTab, workOrder, events, eventsLoading)}
        </CardContent>
      </Card>
    </Box>
  );
}
