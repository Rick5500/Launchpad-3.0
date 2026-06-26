import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, Button, Card, CardContent, Chip, Grid, Typography, Tabs, Tab, Divider } from '@mui/material';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import SectionCard from '../components/SectionCard';
import { authFetch } from '../api';

const tabs = ['Overview', 'Specifications', 'Attachments', 'Activity History', 'Routing', 'Notes'];

function getTabContent(tab, workOrder) {
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
          {getTabContent(activeTab, workOrder)}
        </CardContent>
      </Card>
    </Box>
  );
}
