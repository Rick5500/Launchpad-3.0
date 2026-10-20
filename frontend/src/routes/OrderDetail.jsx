import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Box, Button, Typography } from '@mui/material';
import CustomerShell from '../components/CustomerShell';
import FilesFromAccent from '../components/FilesFromAccent';
import LoadingState from '../components/LoadingState';
import { useAuth } from '../context/AuthContext';
import { authFetch, downloadAuthorized } from '../api';
import { brand, formatClockLabel, formatFileSize } from '../brand';

function Fact({ label, value }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 1, py: 0.4 }}>
      <Typography sx={{ color: brand.muted, fontSize: 14 }}>{label}</Typography>
      <Typography sx={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{value || '—'}</Typography>
    </Box>
  );
}

function lineDetail(item) {
  if (item.fields && item.fields.length) {
    const covered = new Set(item.fields.map((field) => field.key));
    const bits = item.fields.map((field) => `${field.label}: ${field.display || '—'}`);
    if (!covered.has('finishing')) bits.push(`Finishing: ${item.finishing || 'None'}`);
    if (!covered.has('mount')) bits.push(`Mount: ${item.mount_label || (item.mount ? 'Yes' : 'No')}`);
    if (!covered.has('laminate')) bits.push(`Laminate: ${item.laminate_label || (item.laminate ? 'Yes' : 'No')}`);
    return bits.join(' · ');
  }
  return [
    item.size,
    item.quantity,
    item.media,
    item.color,
    item.binding_finish,
    `Finishing ${item.finishing || 'None'}`,
    `Mount ${item.mount_label || (item.mount ? 'Yes' : 'No')}`,
    `Laminate ${item.laminate_label || (item.laminate ? 'Yes' : 'No')}`,
  ].filter(Boolean).join(' · ');
}

export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authFetch(`/api/orders/${id}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Order not found');
        return body;
      })
      .then((body) => {
        if (!cancelled) setOrder(body.order);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Order not found');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const name = user?.contact_name || user?.display_name || user?.username || '';
  const welcome = user?.company && user.company !== name ? `Welcome, ${name} (${user.company})` : `Welcome, ${name}`;

  return (
    <CustomerShell
      title="Submitted Order"
      welcome={welcome}
      onLogout={logout}
      extra={(
        <Button color="inherit" onClick={() => navigate(user?.role === 'customer' ? '/order' : '/')}>
          {user?.role === 'customer' ? 'New Order' : 'Dashboard'}
        </Button>
      )}
    >
      {loading && <LoadingState message="Loading order..." />}
      {error && <Alert severity="error">{error}</Alert>}
      {order && (
        <Box sx={{ display: 'grid', gap: 2 }}>
          <Box sx={{ bgcolor: '#fff', border: `2px solid ${brand.green}`, borderRadius: 1.5, p: 3 }}>
            <Typography sx={{ color: brand.green, fontWeight: 800, fontSize: 24 }}>Order {order.order_number}</Typography>
            <Typography sx={{ color: brand.muted, mt: 0.5 }}>
              Due {order.due_date} at {formatClockLabel(order.due_time)}
            </Typography>
            <Box className="no-print" sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
              <Button variant="outlined" onClick={() => navigate(`/orders/${order.id}/print`)}>Print Work Orders</Button>
              <Button variant="outlined" onClick={() => window.print()}>Print Confirmation</Button>
              <Button variant="contained" onClick={() => navigate('/order')} sx={{ bgcolor: brand.navy }}>Create Another Order</Button>
            </Box>
          </Box>

          {order.bill_to ? (
            <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2 }}>
              <Typography sx={{ fontWeight: 700, color: brand.navy, mb: 1 }}>Bill To</Typography>
              <Fact label="Person" value={order.bill_to.name} />
              <Fact label="Phone" value={order.bill_to.phone} />
              <Fact label="Email" value={order.bill_to.email} />
              <Fact label="Company" value={order.bill_to.company} />
              <Fact label="Addr 1" value={order.bill_to.address_line1} />
              <Fact label="Addr 2" value={order.bill_to.address_line2} />
              <Fact label="City" value={order.bill_to.city} />
              <Fact label="State" value={order.bill_to.state} />
              <Fact label="Zip" value={order.bill_to.zip} />
            </Box>
          ) : null}

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr 1fr' }, gap: 2 }}>
            <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2 }}>
              <Typography sx={{ fontWeight: 700, color: brand.navy, mb: 1 }}>Contact</Typography>
              <Fact label="Company" value={order.company} />
              <Fact label="Contact" value={order.contact_name} />
              <Fact label="Phone" value={order.phone} />
              <Fact label="Email" value={order.email} />
              <Fact label="Addr 1" value={order.address_line1} />
              <Fact label="Addr 2" value={order.address_line2} />
              <Fact label="City" value={order.city} />
              <Fact label="State" value={order.state} />
              <Fact label="Zip" value={order.zip} />
            </Box>
            <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2 }}>
              <Typography sx={{ fontWeight: 700, color: brand.navy, mb: 1 }}>Project</Typography>
              <Fact label="PO Number" value={order.po_number} />
              <Fact label="Project Number" value={order.project_number} />
              <Fact label="Project Name" value={order.project_name} />
              <Fact label="Originals Source" value={order.originals_source_label || 'Not specified'} />
              {order.originals_pickup ? (
                <Typography sx={{ color: brand.muted, fontSize: 13, mt: 0.5 }}>
                  Inbound pickup of originals. This is separate from the delivery method.
                </Typography>
              ) : null}
              <Fact label="Notes" value={order.notes} />
              <Fact label="Payment" value={order.payment_method_label || 'Not specified'} />
            </Box>
            <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2 }}>
              <Typography sx={{ fontWeight: 700, color: brand.navy, mb: 1 }}>Delivery</Typography>
              <Fact label="Return" value={order.return_to_label || order.return_to || 'Not specified'} />
              <Fact label="Method" value={order.delivery_method} />
              {order.ups_account_number ? <Fact label="UPS Account" value={order.ups_account_number} /> : null}
              <Fact label="Hours" value={order.delivery_hours?.label} />
              <Fact label="Ship To" value={order.ship_to} />
              <Fact label="Attention" value={order.attention} />
              <Fact label="Due" value={order.delivery?.due_time} />
            </Box>
          </Box>

          <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2 }}>
            <Typography sx={{ fontWeight: 700, color: brand.navy, mb: 1 }}>Work Orders</Typography>
            {(order.work_orders || []).map((workOrder) => (
              <Box key={workOrder.id} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, py: 0.75, borderBottom: `1px solid ${brand.border}` }}>
                <Typography>
                  <Box component="span" sx={{ fontWeight: 700 }}>{workOrder.external_id}</Box>
                  {' '}
                  {workOrder.service_name}
                  {' · '}
                  {workOrder.department}
                  {workOrder.next_department ? ` → ${workOrder.next_department}` : ''}
                </Typography>
                <Button size="small" onClick={() => navigate(`/work-orders/${workOrder.id}`)}>View</Button>
              </Box>
            ))}
          </Box>

          <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 700, color: brand.navy, mb: 1 }}>Line Items</Typography>
            {(order.line_items || []).length === 0 && <Typography color="text.secondary">No line items.</Typography>}
            {(order.line_items || []).map((item) => (
              <Typography
                key={item.id}
                sx={{
                  fontSize: 14,
                  mb: 0.75,
                  whiteSpace: 'normal',
                  overflowWrap: 'break-word',
                  wordWrap: 'break-word',
                }}
              >
                {item.line_number}. {item.description}
                {item.service_name ? ` · ${item.service_name}` : ''}
                {` · ${lineDetail(item)}`}
              </Typography>
            ))}
          </Box>

          <FilesFromAccent orderId={order.id} canManage={user?.role === 'admin' || user?.role === 'manager' || user?.role === 'operator'} />

          <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2 }}>
            <Typography sx={{ fontWeight: 700, color: brand.navy, mb: 1 }}>Attached Files</Typography>
            {(order.files || []).length === 0 && <Typography color="text.secondary">No files.</Typography>}
            {(order.files || []).map((file) => (
              <Box key={file.id} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, py: 0.5 }}>
                <Typography sx={{ fontSize: 14 }}>{file.original_name} ({formatFileSize(file.size_bytes)})</Typography>
                <Button size="small" onClick={() => downloadAuthorized(`/api/uploads/${file.id}/download`, file.original_name)}>Download</Button>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </CustomerShell>
  );
}
