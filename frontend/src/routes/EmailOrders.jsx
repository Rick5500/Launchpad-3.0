import React, { useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Link,
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
import CustomerOrderForm from './CustomerOrderForm';
import LoadingState from '../components/LoadingState';
import SectionCard from '../components/SectionCard';
import { authFetch, downloadAuthorized } from '../api';
import { brand, formatLocalTimestamp } from '../brand';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../useDocumentTitle';

const STATUS_LABEL = {
  new: 'New',
  converted: 'Converted',
  dismissed: 'Dismissed',
  converting: 'Converting',
};

function statusColor(status) {
  if (status === 'converted') return { bgcolor: '#E5F6EA', color: brand.greenDark };
  if (status === 'dismissed') return { bgcolor: '#EEF2F6', color: brand.muted };
  if (status === 'converting') return { bgcolor: '#FFF4E5', color: brand.orangeDark };
  return { bgcolor: brand.orange, color: '#111' };
}

function formatWhen(value) {
  return formatLocalTimestamp(value) || '—';
}

function StatusChip({ status }) {
  return (
    <Chip
      size="small"
      label={STATUS_LABEL[status] || status}
      sx={{ fontWeight: 700, ...statusColor(status) }}
    />
  );
}

export default function EmailOrders() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  useDocumentTitle(id ? 'Email order' : 'Email Orders');
  const [status, setStatus] = useState('new');
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mailbox, setMailbox] = useState(null);
  const [checking, setChecking] = useState(false);
  const [email, setEmail] = useState(null);
  const [dismissing, setDismissing] = useState(false);

  async function loadStatus() {
    const response = await authFetch('/api/inbound-emails/status');
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Unable to load mailbox status');
    setMailbox(body);
  }

  useEffect(() => {
    let cancelled = false;
    loadStatus().catch((err) => {
      if (!cancelled) setError(err.message || 'Unable to load mailbox status');
    });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (id) return undefined;
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    authFetch(`/api/inbound-emails?${params.toString()}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load emails');
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setRows(body.emails || []);
        setTotal(body.total || 0);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load emails');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [id, status]);

  useEffect(() => {
    if (!id) {
      setEmail(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    authFetch(`/api/inbound-emails/${id}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load this email');
        return body;
      })
      .then((body) => {
        if (!cancelled) {
          setEmail(body);
          setError('');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load this email');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [id]);

  async function checkNow() {
    setChecking(true);
    setError('');
    try {
      const response = await authFetch('/api/inbound-emails/sync', { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to check the mailbox');
      setMailbox(body);
      if (!id) setStatus((current) => current);
      if (id) {
        const detail = await authFetch(`/api/inbound-emails/${id}`);
        const detailBody = await detail.json().catch(() => ({}));
        if (detail.ok) setEmail(detailBody);
      } else {
        const params = new URLSearchParams();
        if (status) params.set('status', status);
        const list = await authFetch(`/api/inbound-emails?${params.toString()}`);
        const listBody = await list.json().catch(() => ({}));
        if (list.ok) {
          setRows(listBody.emails || []);
          setTotal(listBody.total || 0);
        }
      }
    } catch (err) {
      setError(err.message || 'Unable to check the mailbox');
      loadStatus().catch(() => {});
    } finally {
      setChecking(false);
    }
  }

  async function dismiss() {
    setDismissing(true);
    setError('');
    try {
      const response = await authFetch(`/api/inbound-emails/${id}/dismiss`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to dismiss this email');
      setEmail(body);
    } catch (err) {
      setError(err.message || 'Unable to dismiss this email');
    } finally {
      setDismissing(false);
    }
  }

  const syncLine = mailbox?.last_success_at
    ? `Last check ${formatWhen(mailbox.last_success_at)}`
    : 'The mailbox has not been checked yet';

  return (
    <Box data-testid="email-orders-page" sx={{ minWidth: 0, maxWidth: '100%' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start', mb: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ color: brand.navy, fontWeight: 800 }}>
            {id ? 'Email order' : 'Email Orders'}
          </Typography>
          <Typography color="text.secondary">
            Mail sent to the orders mailbox. Nothing is marked read, moved, or deleted.
          </Typography>
        </Box>
        {id ? (
          <Button variant="outlined" onClick={() => navigate('/email-orders')} sx={{ borderColor: brand.navy, color: brand.navy }}>
            Back to list
          </Button>
        ) : null}
      </Box>

      {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}

      <SectionCard
        title="Mailbox"
        subtitle={mailbox?.configured
          ? `${mailbox.mailbox || 'Orders mailbox'} · ${mailbox.folder || 'Inbox'}`
          : 'Microsoft 365 is not configured. Polling stays off until the server environment is set.'}
      >
        <Typography sx={{ mb: 1 }}>{syncLine}</Typography>
        {mailbox?.last_status === 'error' && mailbox.last_error ? (
          <Alert severity="warning" sx={{ mb: 1 }}>{mailbox.last_error}</Alert>
        ) : null}
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {mailbox?.polling_enabled === false
            ? 'Scheduled polling is off. An admin can still check now.'
            : `Scheduled polling is ${mailbox?.configured ? 'on' : 'off'}.`}
        </Typography>
        {isAdmin ? (
          <Button variant="contained" disabled={checking || !mailbox?.configured} onClick={checkNow} sx={{ bgcolor: brand.orange, color: '#111', fontWeight: 700 }}>
            {checking ? 'Checking…' : 'Check now'}
          </Button>
        ) : null}
      </SectionCard>

      {id ? (
        loading && !email ? <LoadingState message="Loading email..." /> : null
      ) : (
        <>
          <Box sx={{ display: 'flex', gap: 2, mb: 2, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
            <TextField
              select
              label="Status"
              size="small"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              sx={{ width: { xs: '100%', sm: 180 }, maxWidth: '100%' }}
            >
              <MenuItem value="new">New</MenuItem>
              <MenuItem value="converted">Converted</MenuItem>
              <MenuItem value="dismissed">Dismissed</MenuItem>
              <MenuItem value="all">All</MenuItem>
            </TextField>
            <Typography color="text.secondary">{total} {total === 1 ? 'email' : 'emails'}</Typography>
          </Box>
          {loading ? <LoadingState message="Loading emails..." /> : null}
          {!loading && rows.length === 0 ? (
            <Alert severity="info">No emails in this list.</Alert>
          ) : null}
          {rows.length ? (
            <TableContainer sx={{ width: '100%', maxWidth: '100%', overflowX: 'auto' }}>
              <Table
                size="small"
                sx={{
                  bgcolor: '#fff',
                  width: '100%',
                  tableLayout: 'fixed',
                  '& th, & td': { overflowWrap: 'anywhere', wordBreak: 'break-word' },
                }}
              >
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ width: '22%' }}>Received</TableCell>
                    <TableCell sx={{ width: '20%' }}>From</TableCell>
                    <TableCell sx={{ width: '28%' }}>Subject</TableCell>
                    <TableCell sx={{ width: '18%' }}>Customer</TableCell>
                    <TableCell sx={{ width: '12%' }}>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id} hover>
                      <TableCell>{formatWhen(row.received_at)}</TableCell>
                      <TableCell>{row.from_name || row.from_address}</TableCell>
                      <TableCell>
                        <Link component={RouterLink} to={`/email-orders/${row.id}`} underline="hover" sx={{ color: brand.navy, fontWeight: 700 }}>
                          {row.subject || '(no subject)'}
                        </Link>
                      </TableCell>
                      <TableCell>{row.matched_customer_name || '—'}</TableCell>
                      <TableCell><StatusChip status={row.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : null}
        </>
      )}

      {email ? (
        <Box data-testid="email-detail">
          <SectionCard title="Message" subtitle={`${email.from_name ? `${email.from_name} · ` : ''}${email.from_address || 'Unknown sender'} · ${formatWhen(email.received_at)}`}>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 1, flexWrap: 'wrap' }}>
              <StatusChip status={email.status} />
              {email.order_id ? (
                <Link component={RouterLink} to={`/orders/${email.order_id}`} underline="hover" sx={{ fontWeight: 700 }}>
                  Order {email.order_number || email.order_id}
                </Link>
              ) : null}
            </Box>
            <Typography data-testid="email-subject" variant="h6" sx={{ color: brand.navy, overflowWrap: 'anywhere' }}>
              {email.subject || '(no subject)'}
            </Typography>
            <Typography
              data-testid="email-body"
              component="div"
              sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', mt: 1 }}
            >
              {email.body_text || 'This message has no body text.'}
            </Typography>
            {email.suggestion?.quantity || email.suggestion?.po_number || email.suggestion?.due_date ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                Suggested
                {email.suggestion.po_number ? ` · PO ${email.suggestion.po_number}` : ''}
                {email.suggestion.quantity ? ` · Quantity ${email.suggestion.quantity}` : ''}
                {email.suggestion.due_date ? ` · Due ${email.suggestion.due_date}` : ''}
                {email.suggestion.match === 'domain' ? ' · Customer matched by domain' : ''}
                {email.suggestion.match === 'email' ? ' · Customer matched by email' : ''}
              </Typography>
            ) : null}
            {!email.suggestion?.customer_id && email.suggestion?.candidate_ids?.length > 1 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Several customers share this sender. Choose the right one on the order form.
              </Typography>
            ) : null}
          </SectionCard>

          <SectionCard title="Attachments" subtitle="Files that are not an allowed type or are over the upload limit are skipped.">
            {(email.attachments || []).length === 0 ? <Typography color="text.secondary">No attachments.</Typography> : null}
            {(email.attachments || []).map((file) => (
              <Box key={file.id} sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 0.75, flexWrap: 'wrap' }}>
                <Typography sx={{ overflowWrap: 'anywhere' }}>{file.original_name}</Typography>
                {file.skipped_reason ? (
                  <Typography variant="body2" color="text.secondary">{file.skipped_reason}</Typography>
                ) : (
                  <Button
                    size="small"
                    onClick={() => downloadAuthorized(`/api/inbound-emails/${email.id}/attachments/${file.id}/download`, file.original_name)}
                  >
                    Download
                  </Button>
                )}
              </Box>
            ))}
            {email.status === 'new' ? (
              <Box sx={{ mt: 1 }}>
                <Button color="inherit" disabled={dismissing} onClick={dismiss}>
                  {dismissing ? 'Dismissing…' : 'Dismiss'}
                </Button>
              </Box>
            ) : null}
          </SectionCard>

          {email.status === 'new' ? (
            <CustomerOrderForm inboundEmail={email} />
          ) : null}
          {email.status === 'dismissed' ? (
            <Alert severity="info">This email was dismissed. It was not turned into an order.</Alert>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
