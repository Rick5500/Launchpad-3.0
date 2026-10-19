import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Grid,
  Snackbar,
  Typography,
  Tabs,
  Tab,
  Divider,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from '@mui/material';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import MoveWorkOrderDialog from '../components/MoveWorkOrderDialog';
import { authFetch, downloadAuthorized } from '../api';
import { requestBoardRefresh } from '../boardEvents';
import { useAuth } from '../context/AuthContext';
import { canonicalWorkOrderStatus, isActiveWorkOrderStatus } from '../workOrderStatus';
import { brand, formatFileSize, formatShopStamp, timezoneLabel } from '../brand';

const tabs = ['Overview', 'Specifications', 'Attachments', 'Scan History', 'Routing', 'Notes'];

function formatStamp(value, timeZone) {
  if (!value) return '—';
  if (timeZone) return formatShopStamp(value, timeZone) || '—';
  return String(value).replace('T', ' ').slice(0, 19);
}

function instructionText(workOrder) {
  const own = String(workOrder?.notes || '').trim();
  const fromOrder = String(workOrder?.order_notes || '').trim();
  return own || fromOrder;
}

function formatDue(value, zoneLabel) {
  if (!value) return '—';
  const text = String(value).trim().replace('T', ' ');
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(text);
  if (!match) return text;
  const date = `${match[2]}/${match[3]}/${match[1]}`;
  if (match[4] == null) return zoneLabel ? `${date} ${zoneLabel}` : date;
  const hour = Number(match[4]);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  const clock = `${hour12}:${match[5]} ${suffix}`;
  return [date, clock, zoneLabel].filter(Boolean).join(' ');
}

function textOn(hex) {
  const value = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return '#fff';
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return (0.299 * red + 0.587 * green + 0.114 * blue) / 255 > 0.62 ? '#1B2838' : '#fff';
}

function statusChipSx(status) {
  const value = canonicalWorkOrderStatus(status);
  if (value === 'completed') return { bgcolor: '#2E7D32', color: '#fff' };
  if (value === 'on-hold') return { bgcolor: brand.orange, color: '#fff' };
  if (value === 'in-progress') return { bgcolor: '#1565C0', color: '#fff' };
  return { bgcolor: brand.navy, color: '#fff' };
}

function zonedWallTimeToUtc(year, month, day, hour, minute, timeZone) {
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let guess = desiredUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(format.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const delta = asUtc - desiredUtc;
    if (delta === 0) return new Date(guess);
    guess -= delta;
  }
  return new Date(guess);
}

function wallClockOverdue(value, timeZone) {
  if (!timeZone) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(value || '').trim());
  if (!match) return false;
  const hour = match[4] != null ? Number(match[4]) : 23;
  const minute = match[5] != null ? Number(match[5]) : 59;
  try {
    const due = zonedWallTimeToUtc(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      hour,
      minute,
      timeZone
    );
    return due.getTime() < Date.now();
  } catch (err) {
    return false;
  }
}

function showText(value) {
  const text = value == null ? '' : String(value).trim();
  return text || '—';
}

function isProofField(field) {
  if (!field) return false;
  if (field.key === 'proof') return true;
  return /^proof$/i.test(String(field.label || '').trim());
}

function BrandCard({ title, children }) {
  return (
    <Card sx={{ overflow: 'hidden', height: '100%' }}>
      <Box sx={{
        px: 2,
        py: 1,
        borderBottom: `1px solid ${brand.border}`,
        borderLeft: `4px solid ${brand.orange}`,
      }}>
        <Typography sx={{ color: brand.navy, fontWeight: 800, letterSpacing: '0.06em', fontSize: 13 }}>
          {title}
        </Typography>
      </Box>
      <CardContent sx={{ pt: 1.5 }}>{children}</CardContent>
    </Card>
  );
}

function Fact({ label, value }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{showText(value)}</Typography>
    </Box>
  );
}

function cityLine(source) {
  if (!source) return '';
  const city = source.city || '';
  const state = source.state || '';
  const zip = source.zip || '';
  const region = [state, zip].filter(Boolean).join(' ');
  return [city, region].filter(Boolean).join(', ');
}

const headCellSx = { color: brand.navy, fontWeight: 700 };
const cellSx = { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', verticalAlign: 'top' };

function ScanHistory({ events, loading, error, timeZone }) {
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
            {['Time', 'Scanned', 'Operator', 'Location', 'Stage'].map((label) => (
              <TableCell key={label} sx={headCellSx}>{label}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.id}>
              <TableCell sx={cellSx}>{formatStamp(event.event_time, timeZone)}</TableCell>
              <TableCell sx={cellSx}>{event.scanned_value}</TableCell>
              <TableCell sx={cellSx}>{event.operator_name || event.operator_username || '—'}</TableCell>
              <TableCell sx={cellSx}>{event.location || '—'}</TableCell>
              <TableCell sx={cellSx}>{event.stage_name || '—'}</TableCell>
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
      <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {workOrder.specifications || 'No specifications recorded for this work order.'}
      </Typography>
    );
  }
  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      {blocks.map((block) => (
        <Box key={`${block.line_number}-${block.title}`} sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700, mb: 1, color: brand.navy, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{block.title}</Typography>
          <Grid container spacing={1}>
            {block.fields.map((field) => (
              <Grid item xs={12} sm={6} key={field.label} sx={{ minWidth: 0 }}>
                <Typography variant="caption" color="text.secondary">{field.label}</Typography>
                <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{field.value || '—'}</Typography>
              </Grid>
            ))}
          </Grid>
        </Box>
      ))}
    </Box>
  );
}

function AttachmentList({ files, legacy, timeZone }) {
  if (!files?.length) {
    return <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{legacy || 'No files are attached to this work order.'}</Typography>;
  }
  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            {['File Name', 'Uploaded', 'Size'].map((label) => (
              <TableCell key={label} sx={headCellSx}>{label}</TableCell>
            ))}
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {files.map((file) => (
            <TableRow key={file.id}>
              <TableCell sx={cellSx}>{file.original_name}</TableCell>
              <TableCell sx={cellSx}>{formatStamp(file.uploaded_at, timeZone)}</TableCell>
              <TableCell sx={cellSx}>{formatFileSize(file.size_bytes)}</TableCell>
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

function RoutingPanel({ workOrder, hideInternal, timeZone }) {
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
        <Typography sx={{ mb: 2, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{workOrder.routing_instructions}</Typography>
      )}
      {history.length > 0 ? (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={headCellSx}>Department</TableCell>
                <TableCell sx={headCellSx}>Status</TableCell>
                <TableCell sx={headCellSx}>Date / Time</TableCell>
                {!hideInternal && <TableCell sx={headCellSx}>Scanned By</TableCell>}
                {!hideInternal && <TableCell sx={headCellSx}>Notes</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {history.map((row) => (
                <TableRow key={row.id}>
                  <TableCell sx={cellSx}>{row.department || '—'}</TableCell>
                  <TableCell sx={cellSx}>{row.status || '—'}</TableCell>
                  <TableCell sx={cellSx}>{formatStamp(row.event_time, timeZone)}</TableCell>
                  {!hideInternal && <TableCell sx={cellSx}>{row.scanned_by || '—'}</TableCell>}
                  {!hideInternal && (
                    <TableCell sx={cellSx}>
                      {row.manual ? <Chip label="Manual" size="small" sx={{ mr: 0.75, bgcolor: brand.orange, color: '#fff', fontWeight: 700 }} /> : null}
                      {row.notes || '—'}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Typography color="text.secondary">No production history recorded.</Typography>
      )}
      {!hideInternal && (workOrder.activity || []).length > 0 && (
        <Box sx={{ mt: 2, display: 'grid', gap: 1 }}>
          <Typography variant="subtitle2" sx={{ color: brand.navy, fontWeight: 800 }}>Activity</Typography>
          {(workOrder.activity || []).map((item) => (
            <Box key={item.id}>
              <Typography sx={{ overflowWrap: 'anywhere' }}>
                {item.manual ? <Chip label="Manual" size="small" sx={{ mr: 0.75, bgcolor: brand.orange, color: '#fff', fontWeight: 700 }} /> : null}
                {item.summary}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {item.actor_name || 'System'} · {formatStamp(item.created_at, timeZone)}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function JobLines({ workOrder }) {
  const items = workOrder.line_items || [];
  if (!items.length) {
    return (
      <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {workOrder.specifications || 'No line items recorded.'}
      </Typography>
    );
  }
  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            {['Line', 'Summary', 'Qty', 'Details'].map((label) => (
              <TableCell key={label} sx={headCellSx}>{label}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {items.map((item) => {
            const fields = (item.fields || []).filter((field) => !isProofField(field));
            return (
              <TableRow key={item.id}>
                <TableCell sx={cellSx}>{item.line_number || '—'}</TableCell>
                <TableCell sx={{ ...cellSx, minWidth: 160 }}>{item.description || '—'}</TableCell>
                <TableCell sx={cellSx}>{item.quantity || '—'}</TableCell>
                <TableCell sx={cellSx}>
                  {fields.length ? fields.map((field) => (
                    <div key={field.key || field.label}>
                      <strong>{field.label}:</strong> {field.display || '—'}
                    </div>
                  )) : '—'}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function proofEntries(workOrder) {
  const rows = [];
  for (const item of workOrder.line_items || []) {
    const proof = (item.fields || []).find(isProofField);
    if (proof) rows.push({ title: item.description || 'Proof', value: proof.display || '—' });
  }
  if (rows.length) return rows;
  for (const block of workOrder.specification_lines || []) {
    for (const field of block.fields || []) {
      if (isProofField(field)) rows.push({ title: block.title || 'Proof', value: field.value || '—' });
    }
  }
  return rows;
}

function Overview({ workOrder, timeZone }) {
  const bill = workOrder.bill_to;
  const proofs = proofEntries(workOrder);
  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={6}>
        <BrandCard title="CUSTOMER">
          <Grid container spacing={1.5}>
            <Grid item xs={12} sm={6}><Fact label="Customer" value={workOrder.customer_name} /></Grid>
            <Grid item xs={12} sm={6}><Fact label="Username" value={workOrder.customer_username} /></Grid>
            <Grid item xs={12} sm={6}><Fact label="Addr 1" value={workOrder.address_line1} /></Grid>
            <Grid item xs={12} sm={6}><Fact label="Addr 2" value={workOrder.address_line2} /></Grid>
            <Grid item xs={12}><Fact label="City / State / Zip" value={cityLine(workOrder)} /></Grid>
          </Grid>
        </BrandCard>
      </Grid>
      <Grid item xs={12} md={6}>
        <BrandCard title="BILL TO / DELIVERY">
          <Grid container spacing={1.5}>
            <Grid item xs={12} sm={6}><Fact label="Delivery Method" value={workOrder.delivery_method} /></Grid>
            <Grid item xs={12} sm={6}><Fact label="Return" value={workOrder.return_to_label || workOrder.return_to || 'Not specified'} /></Grid>
            {workOrder.ups_account_number ? (
              <Grid item xs={12}><Fact label="UPS Account" value={workOrder.ups_account_number} /></Grid>
            ) : null}
            {bill ? (
              <>
                <Grid item xs={12} sm={6}><Fact label="Bill To" value={bill.name} /></Grid>
                <Grid item xs={12} sm={6}><Fact label="Company" value={bill.company} /></Grid>
                <Grid item xs={12} sm={6}><Fact label="Phone" value={bill.phone} /></Grid>
                <Grid item xs={12} sm={6}><Fact label="Email" value={bill.email} /></Grid>
                <Grid item xs={12} sm={6}><Fact label="Addr 1" value={bill.address_line1} /></Grid>
                <Grid item xs={12} sm={6}><Fact label="Addr 2" value={bill.address_line2} /></Grid>
                <Grid item xs={12}><Fact label="City / State / Zip" value={cityLine(bill)} /></Grid>
              </>
            ) : (
              <Grid item xs={12}><Fact label="Bill To" value="—" /></Grid>
            )}
          </Grid>
        </BrandCard>
      </Grid>
      <Grid item xs={12}>
        <BrandCard title="JOB DETAILS">
          <Grid container spacing={1.5} sx={{ mb: 1.5 }}>
            <Grid item xs={12} sm={6} md={3}><Fact label="Service" value={workOrder.service_name} /></Grid>
            <Grid item xs={12} sm={6} md={3}><Fact label="Department" value={workOrder.department} /></Grid>
            <Grid item xs={12} sm={6} md={3}><Fact label="Next Department" value={workOrder.next_department} /></Grid>
            <Grid item xs={12} sm={6} md={3}><Fact label="Quantity" value={workOrder.quantity} /></Grid>
            <Grid item xs={12} sm={6}><Fact label="Project" value={workOrder.project_name} /></Grid>
            <Grid item xs={12} sm={6}><Fact label="Order" value={workOrder.order_number} /></Grid>
          </Grid>
          {workOrder.description ? (
            <Typography sx={{ mb: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{workOrder.description}</Typography>
          ) : null}
          <JobLines workOrder={workOrder} />
        </BrandCard>
      </Grid>
      <Grid item xs={12} md={6}>
        <BrandCard title="ORIGINALS / FILES">
          <Fact label="Originals" value={workOrder.originals_source_label || 'Not specified'} />
          {workOrder.originals_pickup ? (
            <Typography sx={{ mt: 1 }} color="text.secondary">
              Inbound pickup of originals. This is separate from the delivery method.
            </Typography>
          ) : null}
          <Box sx={{ mt: 1.5 }}>
            <AttachmentList files={workOrder.files} legacy={workOrder.attachments} timeZone={timeZone} />
          </Box>
        </BrandCard>
      </Grid>
      <Grid item xs={12} md={6}>
        <Box sx={{ display: 'grid', gap: 2 }}>
          <BrandCard title="SPECIAL INSTRUCTIONS">
            <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {instructionText(workOrder) || 'No notes on this work order.'}
            </Typography>
          </BrandCard>
          <BrandCard title="PROOF">
            {proofs.length ? proofs.map((row, index) => (
              <Fact key={`${index}-${row.value}`} label={proofs.length > 1 ? `Line ${index + 1}` : 'Proof'} value={row.value} />
            )) : <Fact label="Proof" value="Not specified" />}
          </BrandCard>
          <BrandCard title="PAYMENT METHOD">
            <Fact label="Payment" value={workOrder.payment_method_label || 'Not specified'} />
          </BrandCard>
        </Box>
      </Grid>
    </Grid>
  );
}

function getTabContent(tab, workOrder, scanState, hideInternal, timeZone) {
  switch (tab) {
    case 'Overview':
      return <Overview workOrder={workOrder} timeZone={timeZone} />;
    case 'Specifications':
      return <SpecificationBlocks workOrder={workOrder} />;
    case 'Attachments':
      return <AttachmentList files={workOrder.files} legacy={workOrder.attachments} timeZone={timeZone} />;
    case 'Scan History':
      return <ScanHistory events={scanState.events} loading={scanState.loading} error={scanState.error} timeZone={timeZone} />;
    case 'Routing':
      return <RoutingPanel workOrder={workOrder} hideInternal={hideInternal} timeZone={timeZone} />;
    case 'Notes':
      return <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{instructionText(workOrder) || 'No notes on this work order.'}</Typography>;
    default:
      return null;
  }
}

export default function WorkOrderDetail() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { user } = useAuth();
  const canManageOrders = user?.role === 'admin' || user?.role === 'manager' || user?.role === 'operator';
  const canMove = user?.role === 'admin' || user?.role === 'manager';

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
  const [departments, setDepartments] = useState([]);
  const [deliveryZone, setDeliveryZone] = useState('');

  useEffect(() => {
    let cancelled = false;
    authFetch('/api/departments')
      .then(async (response) => {
        if (!response.ok) return [];
        const body = await response.json().catch(() => []);
        return Array.isArray(body) ? body : [];
      })
      .then((rows) => {
        if (!cancelled) setDepartments(rows);
      })
      .catch(() => {});
    authFetch('/api/delivery/rules')
      .then(async (response) => {
        if (!response.ok) return '';
        const body = await response.json().catch(() => ({}));
        return body?.rules?.timezone || '';
      })
      .then((zone) => {
        if (!cancelled) setDeliveryZone(zone);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  const departmentColor = useMemo(() => {
    const name = String(workOrder?.department || '').trim().toLowerCase();
    const match = departments.find((row) => String(row.name || '').trim().toLowerCase() === name);
    return match?.color || '#90caf9';
  }, [departments, workOrder]);

  if (loading) return <LoadingState message="Loading work order details..." />;
  if (error) return <ErrorState message={error} />;
  if (!workOrder) return <ErrorState message="Work order record is missing." />;

  const statusLabel = workOrder.routing?.current_status_label || canonicalWorkOrderStatus(workOrder.status) || '—';
  const zoneLabel = timezoneLabel(deliveryZone, workOrder.due_date);
  const rush = String(workOrder.priority || '').trim().toLowerCase() === 'rush';
  const overdue = Boolean(deliveryZone)
    && isActiveWorkOrderStatus(workOrder.status)
    && wallClockOverdue(workOrder.due_date, deliveryZone);
  const number = workOrder.external_id || `#${workOrder.id}`;

  return (
    <Box sx={{ p: { xs: 1.5, sm: 3 }, maxWidth: 1200, mx: 'auto' }}>
      <Card sx={{ mb: 2, overflow: 'hidden', borderTop: `4px solid ${brand.orange}` }}>
        <CardContent sx={{ p: { xs: 2, sm: 2.5 } }}>
          <Box sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            justifyContent: 'space-between',
            alignItems: { xs: 'stretch', md: 'flex-start' },
            gap: 2,
          }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
                <Box component="img" src="/logo.png" alt="Accent Imaging" sx={{ height: 36, width: 'auto', display: 'block' }} />
                <Typography sx={{ color: brand.orange, fontWeight: 800, letterSpacing: '0.08em', fontSize: 12 }}>
                  WORK ORDER
                </Typography>
              </Box>
              <Typography variant="h4" sx={{ color: brand.navy, fontWeight: 800, overflowWrap: 'anywhere', lineHeight: 1.1 }}>
                {number}
              </Typography>
              <Typography color="text.secondary" sx={{ mt: 0.5 }}>
                {workOrder.customer_name || 'Customer not set'}
                {workOrder.order_number ? ` · Order ${workOrder.order_number}` : ''}
              </Typography>
              <Typography sx={{ mt: 1.25, color: brand.navy, fontWeight: 800, fontSize: 18 }}>
                Due {formatDue(workOrder.due_date, zoneLabel)}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                Created {formatStamp(workOrder.created_at, deliveryZone)} · Updated {formatStamp(workOrder.updated_at, deliveryZone)}
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: { xs: 'flex-start', md: 'flex-end' } }}>
              <Button variant="outlined" sx={{ textTransform: 'none', fontWeight: 700 }} onClick={() => navigate(`/work-orders/${id}/print`)}>
                Print
              </Button>
              {canMove && (
                <Button variant="outlined" sx={{ textTransform: 'none', fontWeight: 700 }} data-testid="move-work-order" onClick={() => setMoveOpen(true)}>
                  Move to…
                </Button>
              )}
              {canManageOrders && (
                <Button variant="contained" color="secondary" sx={{ textTransform: 'none', fontWeight: 700 }} onClick={() => navigate(`/work-orders/${id}/edit`)}>
                  Edit
                </Button>
              )}
            </Box>
          </Box>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2 }}>
            <Chip label={statusLabel} size="small" sx={{ ...statusChipSx(workOrder.status), fontWeight: 700 }} />
            <Chip
              label={workOrder.department || 'No department'}
              size="small"
              sx={{ bgcolor: departmentColor, color: textOn(departmentColor), fontWeight: 700, borderRadius: 1 }}
            />
            <Chip
              label={workOrder.next_department ? `Next: ${workOrder.next_department}` : 'No next department'}
              size="small"
              variant="outlined"
              sx={{ borderColor: brand.navy, color: brand.navy, fontWeight: 700 }}
            />
            <Chip label={`Qty: ${workOrder.quantity ?? '—'}`} size="small" variant="outlined" />
            {rush ? <Chip label="RUSH" size="small" sx={{ bgcolor: brand.orange, color: '#111', fontWeight: 800 }} /> : null}
            {overdue ? <Chip label="OVERDUE" size="small" sx={{ bgcolor: '#fff', color: '#111', border: '2px solid #111', fontWeight: 800 }} /> : null}
          </Box>
        </CardContent>
      </Card>

      <Card>
        <CardContent sx={{ p: { xs: 1.5, sm: 2 } }}>
          <Tabs
            value={activeTab}
            onChange={(_, value) => setActiveTab(value)}
            indicatorColor="secondary"
            textColor="inherit"
            variant="scrollable"
            scrollButtons="auto"
            sx={{
              '& .MuiTab-root': { fontWeight: 700, color: brand.navy },
              '& .Mui-selected': { color: brand.navy },
            }}
          >
            {tabs.map((tab) => (
              <Tab key={tab} label={tab} value={tab} />
            ))}
          </Tabs>
          <Divider sx={{ borderColor: brand.border, my: 2 }} />
          {getTabContent(activeTab, workOrder, { events, loading: eventsLoading, error: eventsError }, user?.role === 'customer', deliveryZone)}
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
