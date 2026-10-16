import React, { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import SectionCard from '../components/SectionCard';
import LoadingState from '../components/LoadingState';
import Pager from '../components/Pager';
import { authFetch } from '../api';

const emptyFilters = {
  order_number: '',
  work_order_number: '',
  company: '',
  contact: '',
  phone: '',
  email: '',
  status: '',
  service: '',
  from: '',
  to: '',
};

export default function SearchOrders() {
  const [filters, setFilters] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);
  const [orders, setOrders] = useState([]);
  const [services, setServices] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const limit = 20;

  useEffect(() => {
    authFetch('/api/orders/options')
      .then((response) => (response.ok ? response.json() : { services: [] }))
      .then((body) => setServices(body.services || []))
      .catch(() => setServices([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset), sort: 'created_at', dir: 'desc' });
    Object.entries(applied).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    authFetch(`/api/search/orders?${params.toString()}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to search orders');
        if (cancelled) return;
        setOrders(body.orders || []);
        setTotal(body.total || 0);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to search orders');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [applied, offset]);

  function update(field, value) {
    setFilters((current) => ({ ...current, [field]: value }));
  }

  return (
    <Box data-testid="search-orders-page">
      <Typography variant="h4" gutterBottom>Search Orders</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Search by order number, work order number, company, contact, phone, email, status, service, or the date the order was created.
      </Typography>
      {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
      <SectionCard title="Filters">
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            setOffset(0);
            setApplied(filters);
          }}
          sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' }, gap: 2 }}
        >
          <TextField label="Order number" value={filters.order_number} onChange={(event) => update('order_number', event.target.value)} />
          <TextField label="Work order number" value={filters.work_order_number} onChange={(event) => update('work_order_number', event.target.value)} />
          <TextField label="Company" value={filters.company} onChange={(event) => update('company', event.target.value)} />
          <TextField label="Contact" value={filters.contact} onChange={(event) => update('contact', event.target.value)} />
          <TextField label="Phone" value={filters.phone} onChange={(event) => update('phone', event.target.value)} />
          <TextField label="Email" value={filters.email} onChange={(event) => update('email', event.target.value)} />
          <TextField select label="Status" value={filters.status} onChange={(event) => update('status', event.target.value)}>
            <MenuItem value="">Any status</MenuItem>
            <MenuItem value="open">Open</MenuItem>
            <MenuItem value="in-progress">In progress</MenuItem>
            <MenuItem value="completed">Completed</MenuItem>
            <MenuItem value="on-hold">On hold</MenuItem>
          </TextField>
          <TextField select label="Service" value={filters.service} onChange={(event) => update('service', event.target.value)}>
            <MenuItem value="">Any service</MenuItem>
            {services.map((service) => <MenuItem key={service.id} value={String(service.id)}>{service.name}</MenuItem>)}
          </TextField>
          <TextField label="Created from" type="date" value={filters.from} onChange={(event) => update('from', event.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField label="Created to" type="date" value={filters.to} onChange={(event) => update('to', event.target.value)} InputLabelProps={{ shrink: true }} />
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Button type="submit" variant="contained">Search</Button>
            <Button onClick={() => { setFilters(emptyFilters); setApplied(emptyFilters); setOffset(0); }}>Clear</Button>
          </Box>
        </Box>
      </SectionCard>
      <SectionCard title="Results">
        {loading ? <LoadingState message="Searching..." /> : null}
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Order</TableCell>
                <TableCell>Company</TableCell>
                <TableCell>Contact</TableCell>
                <TableCell>Originals</TableCell>
                <TableCell>Payment</TableCell>
                <TableCell>Phone</TableCell>
                <TableCell>Line details</TableCell>
                <TableCell>Work orders</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <Button component={RouterLink} to={order.detail_path} size="small">{order.order_number}</Button>
                  </TableCell>
                  <TableCell>{order.company}</TableCell>
                  <TableCell>{order.contact_name}</TableCell>
                  <TableCell>{order.originals_source_label || 'Not specified'}</TableCell>
                  <TableCell>{order.payment_method_label || 'Not specified'}</TableCell>
                  <TableCell>{order.phone}</TableCell>
                  <TableCell sx={{ maxWidth: 360 }}>
                    {(order.line_details || []).length
                      ? (order.line_details || []).map((line) => <Box key={line} sx={{ fontSize: 12, mb: 0.5 }}>{line}</Box>)
                      : '—'}
                  </TableCell>
                  <TableCell>
                    {(order.work_orders || []).map((workOrder) => (
                      <Box key={workOrder.id} sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 0.5 }}>
                        <Button component={RouterLink} to={workOrder.detail_path} size="small">
                          {workOrder.external_id || `#${workOrder.id}`}
                        </Button>
                        <Button component={RouterLink} to={workOrder.print_path} size="small">Print</Button>
                      </Box>
                    ))}
                  </TableCell>
                </TableRow>
              ))}
              {!loading && orders.length === 0 ? (
                <TableRow><TableCell colSpan={8}>No orders match.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </TableContainer>
        <Pager offset={offset} limit={limit} total={total} onChange={setOffset} />
      </SectionCard>
    </Box>
  );
}
