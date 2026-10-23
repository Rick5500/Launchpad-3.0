import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  TextField,
  Typography,
} from '@mui/material';
import QuoteStatusChip from '../components/QuoteStatusChip';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { authFetch, downloadAuthorized } from '../api';
import { brand, formatFileSize } from '../brand';
import { quoteBodySx, quoteFieldSx, quotePrimaryButtonSx } from '../quoteUi';

const FILTERS = ['New', 'Quoted', 'Accepted', 'Declined', 'All'];
const EMPTY_LINE = { code: '', unit: '', quantity: '', description: '', price: '' };

function money(quote) {
  return quote?.price_label || (quote?.price ? `$${quote.price}` : '');
}

export default function QuoteRequests() {
  const { id } = useParams();
  const navigate = useNavigate();
  if (id) return <QuoteDetail id={id} onBack={() => navigate('/quote-requests')} />;
  return <QuoteList onOpen={(quote) => navigate(`/quote-requests/${quote.id}`)} />;
}

function QuoteList({ onOpen }) {
  const [status, setStatus] = useState('New');
  const [quotes, setQuotes] = useState([]);
  const [newCount, setNewCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const query = status === 'All' ? '' : `?status=${encodeURIComponent(status)}`;
    authFetch(`/api/quote-requests${query}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load quote requests');
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setQuotes(body.quotes || []);
        setNewCount(body.new_count || 0);
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load quote requests');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  return (
    <Box data-testid="quote-requests-list" sx={{ maxWidth: 1100, mx: 'auto' }}>
      <Typography variant="h4" component="h1" sx={{ color: brand.navy, fontWeight: 800, fontSize: { xs: '1.9rem', sm: '2.15rem' } }}>
        Quote Requests
      </Typography>
      <Typography sx={{ ...quoteBodySx, color: brand.muted, mt: 0.75, mb: 2 }}>
        {newCount} new {newCount === 1 ? 'request' : 'requests'}. Open one to review the specs and send a price.
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
        {FILTERS.map((item) => {
          const selected = status === item;
          return (
            <Button
              key={item}
              data-testid={`quote-filter-${item}`}
              variant={selected ? 'contained' : 'outlined'}
              onClick={() => setStatus(item)}
              sx={{
                ...quotePrimaryButtonSx,
                bgcolor: selected ? brand.orange : '#fff',
                color: selected ? '#111' : brand.navy,
                borderColor: brand.navy,
                '&:hover': { bgcolor: selected ? brand.orangeDark : '#fff', color: selected ? '#fff' : brand.navy },
              }}
            >
              {item}
            </Button>
          );
        })}
      </Box>
      {loading ? <LoadingState message="Loading quote requests..." /> : null}
      {error ? <ErrorState message={error} /> : null}
      {!loading && !error && quotes.length === 0 ? (
        <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: 2.5 }}>
          <Typography sx={{ ...quoteBodySx }}>No {status === 'All' ? '' : `${status} `}quote requests.</Typography>
        </Box>
      ) : null}
      <Box sx={{ display: 'grid', gap: 1.25 }}>
        {quotes.map((quote) => (
          <Box
            key={quote.id}
            data-testid="staff-quote-row"
            sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderLeft: `4px solid ${brand.navy}`, borderRadius: 1.5, p: { xs: 1.75, sm: 2 } }}
          >
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
              <Box>
                <Typography sx={{ fontWeight: 800, color: brand.navy, fontSize: '1.3rem' }}>{quote.project_name}</Typography>
                <Typography sx={{ ...quoteBodySx, color: brand.muted }}>
                  {quote.customer_name || 'Customer'}
                  {quote.customer_company ? ` · ${quote.customer_company}` : ''}
                  {quote.needed_by ? ` · Needed by ${quote.needed_by}` : ''}
                </Typography>
              </Box>
              <QuoteStatusChip status={quote.status} />
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, flexWrap: 'wrap', alignItems: 'center', mt: 1.25 }}>
              <Typography sx={{ fontSize: '1.2rem', fontWeight: 800, color: brand.navy }}>{money(quote)}</Typography>
              <Button variant="contained" onClick={() => onOpen(quote)} sx={{ ...quotePrimaryButtonSx, bgcolor: brand.navy, '&:hover': { bgcolor: brand.navyDark } }}>
                Open
              </Button>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function Fact({ label, value }) {
  if (value == null || String(value).trim() === '') return null;
  return (
    <Box>
      <Typography sx={{ fontSize: '1rem', fontWeight: 800, color: brand.muted }}>{label}</Typography>
      <Typography sx={{ ...quoteBodySx, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value}</Typography>
    </Box>
  );
}

function QuoteDetail({ id, onBack }) {
  const navigate = useNavigate();
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [price, setPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [lines, setLines] = useState([{ ...EMPTY_LINE }]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/quote-requests/${id}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load this quote request');
        return body.quote;
      })
      .then((row) => {
        if (cancelled) return;
        setQuote(row);
        setPrice(row.price || '');
        setNotes(row.quote_notes || '');
        setValidUntil(row.valid_until || '');
        setLines(row.line_items?.length ? row.line_items.map((line) => ({
          code: line.code || '',
          unit: line.unit || '',
          quantity: line.quantity || '',
          description: line.description || '',
          price: line.price || '',
        })) : [{ ...EMPTY_LINE }]);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load this quote request');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  function updateLine(index, field, value) {
    setLines((current) => current.map((line, lineIndex) => (
      lineIndex === index ? { ...line, [field]: value } : line
    )));
  }

  async function sendQuote(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await authFetch(`/api/quote-requests/${id}/quote`, {
        method: 'POST',
        body: JSON.stringify({
          price,
          notes,
          valid_until: validUntil,
          line_items: lines,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to send this quote');
      setQuote(body.quote);
      setMessage(body.quote.quote_version > 1 ? 'Quote updated and sent again.' : 'Quote sent.');
    } catch (err) {
      setError(err.message || 'Unable to send this quote');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState message="Loading quote request..." />;
  if (error && !quote) return <ErrorState message={error} />;
  if (!quote) return null;
  const canRevise = !quote.converted_order_id;

  return (
    <Box data-testid="quote-detail" sx={{ maxWidth: 980, mx: 'auto' }}>
      <Button onClick={onBack} sx={{ fontSize: '1.05rem', fontWeight: 800, color: brand.navy, mb: 1 }}>
        Back to Quote Requests
      </Button>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
        <Box>
          <Typography variant="h4" component="h1" sx={{ color: brand.navy, fontWeight: 800, fontSize: { xs: '1.9rem', sm: '2.15rem' } }}>
            {quote.project_name}
          </Typography>
          <Typography sx={{ ...quoteBodySx, color: brand.muted }}>
            {quote.customer_name || 'Customer'}
            {quote.customer_company ? ` · ${quote.customer_company}` : ''}
            {quote.customer_email ? ` · ${quote.customer_email}` : ''}
          </Typography>
        </Box>
        <QuoteStatusChip status={quote.status} />
      </Box>
      {message ? <Alert severity="success" sx={{ mb: 2, '& .MuiAlert-message': { fontSize: '1.1rem' } }}>{message}</Alert> : null}
      {error ? <Alert severity="error" sx={{ mb: 2, '& .MuiAlert-message': { fontSize: '1.1rem' } }}>{error}</Alert> : null}
      <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: { xs: 2, sm: 2.5 }, display: 'grid', gap: 1.5, mb: 2 }}>
        <Fact label="Description / specs" value={quote.description} />
        <Fact label="Quantity" value={quote.quantity} />
        <Fact label="Size" value={quote.size} />
        <Fact label="Material / stock" value={quote.material} />
        <Fact label="Finishing / notes" value={quote.finishing} />
        <Fact label="Needed by" value={quote.needed_by} />
        {quote.decline_reason ? <Fact label="Decline reason" value={quote.decline_reason} /> : null}
        {quote.files?.length ? (
          <Box>
            <Typography sx={{ fontSize: '1rem', fontWeight: 800, color: brand.muted, mb: 0.5 }}>Files</Typography>
            {quote.files.map((file) => (
              <Box key={file.id} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'center', py: 0.5 }}>
                <Typography sx={{ fontSize: '1.1rem', overflowWrap: 'anywhere' }}>
                  {file.original_name} · {formatFileSize(file.size_bytes)}
                </Typography>
                <Button onClick={() => downloadAuthorized(`/api/uploads/${file.id}/download`, file.original_name)} sx={{ fontWeight: 800, fontSize: '1.05rem' }}>
                  Download
                </Button>
              </Box>
            ))}
          </Box>
        ) : (
          <Typography sx={{ ...quoteBodySx, color: brand.muted }}>No files attached.</Typography>
        )}
        {quote.converted_order_id ? (
          <Button variant="outlined" onClick={() => navigate(`/orders/${quote.converted_order_id}`)} sx={{ ...quotePrimaryButtonSx, justifySelf: 'start', borderColor: brand.navy, color: brand.navy }}>
            Open order {quote.order_number || quote.converted_order_id}
          </Button>
        ) : null}
        {quote.status === 'Accepted' && !quote.converted_order_id ? (
          <Button
            data-testid="convert-to-order"
            variant="contained"
            onClick={() => navigate(`/order?fromQuote=${quote.id}`)}
            sx={{ ...quotePrimaryButtonSx, justifySelf: 'start', bgcolor: brand.orange, color: '#111', '&:hover': { bgcolor: brand.orangeDark, color: '#fff' } }}
          >
            Convert to Order
          </Button>
        ) : null}
      </Box>

      {canRevise ? (
        <Box component="form" data-testid="quote-send-form" onSubmit={sendQuote} sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderTop: `4px solid ${brand.orange}`, borderRadius: 1.5, p: { xs: 2, sm: 2.5 }, display: 'grid', gap: 2 }}>
          <Typography sx={{ fontWeight: 800, color: brand.navy, fontSize: '1.45rem' }}>
            {quote.quote_version > 0 ? 'Revise and send quote' : 'Send Quote'}
          </Typography>
          <Typography sx={{ ...quoteBodySx, color: brand.muted }}>
            Sending sets the status to Quoted and notifies the customer. Mail goes out only when email is set up.
          </Typography>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            <TextField label="Price (total)" required value={price} onChange={(event) => setPrice(event.target.value)} placeholder="0.00" sx={quoteFieldSx} />
            <TextField label="Valid until" type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} InputLabelProps={{ shrink: true }} sx={quoteFieldSx} />
          </Box>
          <TextField label="Notes / terms" multiline minRows={3} value={notes} onChange={(event) => setNotes(event.target.value)} sx={quoteFieldSx} />
          <Box>
            <Typography sx={{ fontWeight: 800, fontSize: '1.15rem', mb: 1 }}>Line items</Typography>
            <Box sx={{ overflowX: 'auto' }}>
              <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', minWidth: 720, '& th, & td': { p: 0.75, borderBottom: `1px solid ${brand.border}`, verticalAlign: 'top' }, '& th': { textAlign: 'left', fontSize: '1.05rem', fontWeight: 800, color: brand.navy } }}>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Unit</th>
                    <th>Quantity</th>
                    <th>Description</th>
                    <th>Price</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={index}>
                      {['code', 'unit', 'quantity', 'description', 'price'].map((field) => (
                        <td key={field}>
                          <TextField
                            value={line[field]}
                            onChange={(event) => updateLine(index, field, event.target.value)}
                            aria-label={`${field} line ${index + 1}`}
                            sx={{ ...quoteFieldSx, minWidth: field === 'description' ? 180 : 90 }}
                          />
                        </td>
                      ))}
                      <td>
                        <Button type="button" onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))} sx={{ fontWeight: 800 }}>
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Box>
            </Box>
            <Button type="button" onClick={() => setLines((current) => [...current, { ...EMPTY_LINE }])} sx={{ mt: 1, fontWeight: 800, fontSize: '1.05rem', color: brand.navy }}>
              Add line
            </Button>
          </Box>
          <Button type="submit" variant="contained" disabled={saving} sx={{ ...quotePrimaryButtonSx, justifySelf: 'start', bgcolor: brand.navy, '&:hover': { bgcolor: brand.navyDark } }}>
            {saving ? 'Sending…' : quote.quote_version > 0 ? 'Send updated quote' : 'Send Quote'}
          </Button>
        </Box>
      ) : (
        <Alert severity="info" sx={{ '& .MuiAlert-message': { fontSize: '1.1rem' } }}>
          This quote was converted to an order, so the price is locked.
        </Alert>
      )}
    </Box>
  );
}
