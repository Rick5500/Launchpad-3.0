import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Box, Button, Card, CardContent, Chip, Grid, Snackbar, Typography, Tabs, Tab, Divider, Table, TableBody, TableCell, TableContainer, TableHead, TableRow } from '@mui/material';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import SectionCard from '../components/SectionCard';
import MoveWorkOrderDialog from '../components/MoveWorkOrderDialog';
import { authFetch, downloadAuthorized } from '../api';
import { requestBoardRefresh } from '../boardEvents';
import { useAuth } from '../context/AuthContext';
import { canonicalWorkOrderStatus } from '../workOrderStatus';
import { formatFileSize } from '../brand';

const tabs = ['Overview', 'Specifications', 'Attachments', 'Scan History', 'Routing', 'Notes'];

function formatStamp(value) {
  if (!value) return '—';
  return String(value).replace('T', ' ').slice(0, 19);
}

function ScanHistory({ events, loading, error }) {
  if (loading) return <Typography color="text.secondary">Loading scans...</Typography>;
  if (error) return <Typography color="error">{error}</Typography>;
  if (!events.length) {
    return <Typography color="text.secondary">No barcode scans recorded for this work order yet.</Typography>;
  }

  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Time</TableCell>
            <TableCell>Scanned</TableCell>
            <TableCell>Operator</TableCell>
            <TableCell>Location</TableCell>
            <TableCell>Stage</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.id}>
              <TableCell>{formatStamp(event.event_time)}</TableCell>
              <TableCell>{event.scanned_value}</TableCell>
              <TableCell>{event.operator_name || event.operator_username || '—'}</TableCell>
              <TableCell>{event.location || '—'}</TableCell>
              <TableCell>{event.stage_name || '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function SpecificationBlocks({ workOrder }) {
  const blocks = workOrder.specification_lines || [];
  if (!blocks.length) {
    return (
      <Typography sx={{ whiteSpace: 'pre-wrap' }}>
        {workOrder.specifications || 'No specifications recorded for this work order.'}
      </Typography>
    );
  }
  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      {blocks.map((block) => (
        <Box key={`${block.line_number}-${block.title}`} sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700, mb: 1, whiteSpace: 'normal', overflowWrap: 'break-word', wordWrap: 'break-word' }}>{block.title}</Typography>
          <Grid container spacing={1}>
            {block.fields.map((field) => (
              <Grid item xs={12} sm={6} key={field.label} sx={{ minWidth: 0 }}>
                <Typography variant="caption" color="text.secondary">{field.label}</Typography>
                <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordWrap: 'break-word' }}>{field.value || '—'}</Typography>
              </Grid>
            ))}
          </Grid>
        </Box>
      ))}
    </Box>
  );
}

function AttachmentList({ files, legacy }) {
  if (!files?.length) {
    return <Typography sx={{ whiteSpace: 'pre-wrap' }}>{legacy || 'No files are attached to this work order.'}</Typography>;
  }
  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>File Name</TableCell>
            <TableCell>Uploaded</TableCell>
            <TableCell>Size</TableCell>
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {files.map((file) => (
            <TableRow key={file.id}>
              <TableCell>{file.original_name}</TableCell>
              <TableCell>{formatStamp(file.uploaded_at)}</TableCell>
              <TableCell>{formatFileSize(file.size_bytes)}</TableCell>
              <TableCell>
                <Button size="small" onClick={() => downloadAuthorized(`/api/uploads/${file.id}/download`, file.original_name)}>
                  Download
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function RoutingPanel({ workOrder, hideInternal }) {
  const routing = workOrder.routing || {};
  const history = workOrder.production_history || [];
  return (
    <Box>
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} sm={4}>
          <Typography variant="caption" color="text.secondary">Department</Typography>
          <Typography>{routing.department || workOrder.department || '—'}</Typography>
        </Grid>
        <Grid item xs={12} sm={4}>
          <Typography variant="caption" color="text.secondary">Current Status</Typography>
          <Typography>{routing.current_status_label || canonicalWorkOrderStatus(workOrder.status) || '—'}</Typography>
        </Grid>
        <Grid item xs={12} sm={4}>
          <Typography variant="caption" color="text.secondary">Next Department</Typography>
          <Typography>{routing.next_department || workOrder.next_department || '—'}</Typography>
        </Grid>
      </Grid>
      {workOrder.routing_instructions && (
        <Typography sx={{ mb: 2 }}>{workOrder.routing_instructions}</Typography>
      )}
      {history.length > 0 && (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Department</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Date / Time</TableCell>
                {!hideInternal && <TableCell>Scanned By</TableCell>}
                {!hideInternal && <TableCell>Notes</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {history.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.department || '—'}</TableCell>
                  <TableCell>{row.status || '—'}</TableCell>
                  <TableCell>{formatStamp(row.event_time)}</TableCell>
                  {!hideInternal && <TableCell>{row.scanned_by || '—'}</TableCell>}
                  {!hideInternal && (
                    <TableCell>
                      {row.manual ? <Chip label="Manual" size="small" sx={{ mr: 0.75 }} /> : null}
                      {row.notes || '—'}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {!hideInternal && (workOrder.activity || []).length > 0 && (
        <Box sx={{ mt: 2, display: 'grid', gap: 1 }}>
          <Typography variant="subtitle2">Activity</Typography>
          {(workOrder.activity || []).map((item) => (
            <Box key={item.id}>
              <Typography>
                {item.manual ? <Chip label="Manual" size="small" sx={{ mr: 0.75 }} /> : null}
                {item.summary}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {item.actor_name || 'System'} · {formatStamp(item.created_at)}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function getTabContent(tab, workOrder, scanState, hideInternal) {
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
              'Order': workOrder.order_number,
              'Service': workOrder.service_name,
              'Status': workOrder.routing?.current_status_label || canonicalWorkOrderStatus(workOrder.status),
              'Department': workOrder.department,
              'Next Department': workOrder.next_department,
              'Quantity': workOrder.quantity,
              'Due Date': workOrder.due_date,
              'Delivery Method': workOrder.delivery_method,
              'Return': workOrder.return_to_label || workOrder.return_to || 'Not specified',
              'Payment Method': workOrder.payment_method_label || 'Not specified',
              ...(workOrder.ups_account_number ? { 'UPS Account': workOrder.ups_account_number } : {}),
              ...(workOrder.bill_to ? {
                'Bill To': workOrder.bill_to.name,
                'Bill To Phone': workOrder.bill_to.phone,
                'Bill To Email': workOrder.bill_to.email,
                'Bill To Company': workOrder.bill_to.company,
                'Bill To Addr 1': workOrder.bill_to.address_line1,
                'Bill To Addr 2': workOrder.bill_to.address_line2,
                'Bill To City': workOrder.bill_to.city,
                'Bill To State': workOrder.bill_to.state,
                'Bill To Zip': workOrder.bill_to.zip,
              } : {}),
              'Customer': workOrder.customer_name,
              'Customer Username': workOrder.customer_username,
              'Originals Source': workOrder.originals_source_label || 'Not specified',
              'Addr 1': workOrder.address_line1,
              'Addr 2': workOrder.address_line2,
              'City': workOrder.city,
              'State': workOrder.state,
              'Zip': workOrder.zip,
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
          {workOrder.originals_pickup ? (
            <Typography sx={{ mt: 2 }} color="text.secondary">
              Inbound pickup of originals. This is separate from the delivery method.
            </Typography>
          ) : null}
        </Box>
      );
    case 'Specifications':
      return <SpecificationBlocks workOrder={workOrder} />;
    case 'Attachments':
      return <AttachmentList files={workOrder.files} legacy={workOrder.attachments} />;
    case 'Scan History':
      return <ScanHistory events={scanState.events} loading={scanState.loading} error={scanState.error} />;
    case 'Routing':
      return <RoutingPanel workOrder={workOrder} hideInternal={hideInternal} />;
    case 'Notes':
      return <Typography sx={{ whiteSpace: 'pre-wrap' }}>{workOrder.notes || 'No notes on this work order.'}</Typography>;
    default:
      return null;
  }
}

function sameDepartment(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function canMoveWorkOrder(user, department) {
  if (user?.role === 'admin') return true;
  if (user?.role !== 'manager') return false;
  const home = String(user.department || '').trim();
  if (!home) return true;
  return sameDepartment(home, department);
}

export default function WorkOrderDetail() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { user } = useAuth();
  const canManageOrders = user?.role === 'admin' || user?.role === 'manager' || user?.role === 'operator';

  const [workOrder, setWorkOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('Overview');
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState('');
  const [moveOpen, setMoveOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setEventsLoading(true);
    setEventsError('');

    authFetch(`/api/workorders/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error('Work order not found');
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setWorkOrder(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load work order');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    authFetch(`/api/workorders/${id}/events`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Unable to load scan history');
        return body;
      })
      .then((data) => {
        if (!cancelled) setEvents(data.events || []);
      })
      .catch((err) => {
        if (!cancelled) setEventsError(err.message || 'Unable to load scan history');
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  if (loading) return <LoadingState message="Loading work order details..." />;
  if (error) return <ErrorState message={error} />;
  if (!workOrder) return <ErrorState message="Work order record is missing." />;

  const showMove = canMoveWorkOrder(user, workOrder.department);

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
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button variant="outlined" onClick={() => navigate(`/work-orders/${id}/print`)}>
            Print Work Order
          </Button>
          {showMove && (
            <Button variant="outlined" data-testid="move-work-order" onClick={() => setMoveOpen(true)}>
              Move to…
            </Button>
          )}
          {canManageOrders && (
            <Button variant="contained" onClick={() => navigate(`/work-orders/${id}/edit`)}>
              Edit Work Order
            </Button>
          )}
        </Box>
      </Box>

      <Box sx={{ mt: 2, mb: 3 }}>
        <Chip label={workOrder.routing?.current_status_label || canonicalWorkOrderStatus(workOrder.status) || '-'} color="primary" sx={{ mr: 1 }} />
        <Chip label={workOrder.department || 'No department'} sx={{ mr: 1 }} />
        <Chip label={workOrder.next_department ? `Next: ${workOrder.next_department}` : 'No next department'} sx={{ mr: 1 }} />
        <Chip label={`Qty: ${workOrder.quantity}`} />
      </Box>

      <Card sx={{ bgcolor: '#ffffff' }}>
        <CardContent>
          <Tabs value={activeTab} onChange={(_, value) => setActiveTab(value)} indicatorColor="primary" textColor="inherit" variant="scrollable" scrollButtons="auto">
            {tabs.map((tab) => (
              <Tab key={tab} label={tab} value={tab} />
            ))}
          </Tabs>
          <Divider sx={{ borderColor: '#e2e8f0', my: 2 }} />
          {getTabContent(activeTab, workOrder, { events, loading: eventsLoading, error: eventsError }, user?.role === 'customer')}
        </CardContent>
      </Card>
      <MoveWorkOrderDialog
        open={moveOpen}
        workOrder={workOrder}
        onClose={() => setMoveOpen(false)}
        onMoved={(message) => {
          setNotice(message);
          setReloadKey((value) => value + 1);
          requestBoardRefresh();
        }}
      />
      <Snackbar open={Boolean(notice)} autoHideDuration={4000} onClose={() => setNotice('')} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity="success" onClose={() => setNotice('')} sx={{ width: '100%' }}>{notice}</Alert>
      </Snackbar>
    </Box>
  );
}
