import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { QuotePrintCredit } from '../components/AcgMark';
import QuoteStatusChip from '../components/QuoteStatusChip';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { authFetch, downloadAuthorized } from '../api';
import { useAuth } from '../context/AuthContext';
import { brand, formatFileSize } from '../brand';
import { quoteBodySx, quoteFieldSx, quotePrimaryButtonSx } from '../quoteUi';

const EMPTY_FORM = {
  project_name: '',
  description: '',
  quantity: '',
  size: '',
  material: '',
  finishing: '',
  needed_by: '',
  location_id: '',
};

function money(quote) {
  return quote.price_label || (quote.price ? `$${quote.price}` : '');
}

export default function CustomerQuotes() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const isNew = location.pathname.endsWith('/quotes/new');

  if (isNew) return <RequestForm onCreated={(quote) => navigate(`/quotes/${quote.id}`)} />;
  if (id) return <QuoteDetail id={id} onBack={() => navigate('/quotes')} />;
  return <MyQuotes onNew={() => navigate('/quotes/new')} onOpen={(quote) => navigate(`/quotes/${quote.id}`)} />;
}

function PageTitle({ title, subtitle }) {
  return (
    <Box sx={{ mb: 2.5 }}>
      <Typography variant="h4" component="h1" sx={{ color: brand.navy, fontWeight: 800, fontSize: { xs: '1.9rem', sm: '2.15rem' } }}>
        {title}
      </Typography>
      {subtitle ? (
        <Typography sx={{ ...quoteBodySx, color: brand.muted, mt: 0.75 }}>{subtitle}</Typography>
      ) : null}
    </Box>
  );
}

function MyQuotes({ onNew, onOpen }) {
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    authFetch('/api/quote-requests')
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load quotes');
        return body;
      })
      .then((body) => {
        if (!cancelled) setQuotes(body.quotes || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load quotes');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Box data-testid="my-quotes" sx={{ maxWidth: 920, mx: 'auto' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <PageTitle
          title="My Quotes"
          subtitle="Each request, where it stands, and the quote from Accent when it has been sent."
        />
        <Button variant="contained" onClick={onNew} sx={{ ...quotePrimaryButtonSx, bgcolor: brand.orange, color: '#111', '&:hover': { bgcolor: brand.orangeDark, color: '#fff' } }}>
          Request a Quote
        </Button>
      </Box>
      {loading ? <LoadingState message="Loading quotes..." /> : null}
      {error ? <ErrorState message={error} /> : null}
      {!loading && !error && quotes.length === 0 ? (
        <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderTop: `4px solid ${brand.orange}`, borderRadius: 1.5, p: 2.5 }}>
          <Typography sx={{ ...quoteBodySx, fontWeight: 700 }}>No quote requests yet.</Typography>
          <Typography sx={{ ...quoteBodySx, color: brand.muted, mt: 0.5 }}>
            Request a quote when you know the job but not the price.
          </Typography>
        </Box>
      ) : null}
      <Box sx={{ display: 'grid', gap: 1.5 }}>
        {quotes.map((quote) => (
          <Box
            key={quote.id}
            data-testid="quote-card"
            sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderTop: `4px solid ${brand.orange}`, borderRadius: 1.5, p: { xs: 1.75, sm: 2.25 } }}
          >
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
              <Typography sx={{ fontWeight: 800, color: brand.navy, fontSize: '1.3rem', overflowWrap: 'anywhere' }}>
                {quote.project_name}
              </Typography>
              <QuoteStatusChip status={quote.status} />
            </Box>
            <Typography sx={{ ...quoteBodySx, mt: 1 }}>
              Qty {quote.quantity || '—'}
              {quote.needed_by ? ` · Needed by ${quote.needed_by}` : ''}
              {quote.file_count ? ` · ${quote.file_count} file${quote.file_count === 1 ? '' : 's'}` : ''}
            </Typography>
            {quote.status !== 'New' && money(quote) ? (
              <Typography data-testid="quote-price" sx={{ mt: 1, fontSize: '1.35rem', fontWeight: 800, color: brand.navy }}>
                {money(quote)}
                {quote.valid_until ? <Box component="span" sx={{ fontWeight: 600, fontSize: '1.05rem', color: brand.muted }}> · valid until {quote.valid_until}</Box> : null}
              </Typography>
            ) : null}
            {quote.quote_notes ? (
              <Typography sx={{ ...quoteBodySx, mt: 1, whiteSpace: 'pre-wrap' }}>{quote.quote_notes}</Typography>
            ) : null}
            <Button variant="contained" onClick={() => onOpen(quote)} sx={{ ...quotePrimaryButtonSx, mt: 1.5, bgcolor: brand.navy, '&:hover': { bgcolor: brand.navyDark } }}>
              {quote.status === 'Quoted' ? 'Review quote' : 'View request'}
            </Button>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function RequestForm({ onCreated }) {
  const { user } = useAuth();
  const [form, setForm] = useState(EMPTY_FORM);
  const [files, setFiles] = useState([]);
  const [locations, setLocations] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    authFetch('/api/locations')
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) return;
        setLocations(body.locations || []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!user?.location_id) return;
    setForm((current) => (current.location_id ? current : { ...current, location_id: String(user.location_id) }));
  }, [user]);

  function update(field) {
    return (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  }

  async function uploadFiles(list) {
    const chosen = Array.from(list || []);
    if (!chosen.length) return;
    const pending = chosen.map((file) => ({
      key: `${file.name}-${file.size}-${Math.random().toString(16).slice(2)}`,
      original_name: file.name,
      size_bytes: file.size,
      status: 'uploading',
    }));
    setFiles((current) => [...current, ...pending]);
    const body = new FormData();
    chosen.forEach((file) => body.append('files', file));
    try {
      const response = await authFetch('/api/uploads', { method: 'POST', body });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Upload failed');
      const saved = payload.files || [];
      setFiles((current) => {
        const next = current.filter((file) => !pending.some((item) => item.key === file.key));
        return [...next, ...saved.map((file) => ({ ...file, status: 'uploaded' }))];
      });
    } catch (err) {
      setFiles((current) => current.map((file) => (
        pending.some((item) => item.key === file.key)
          ? { ...file, status: 'error', error: err.message || 'Upload failed' }
          : file
      )));
      setError(err.message || 'Upload failed');
    }
  }

  async function removeFile(file) {
    if (file.id) await authFetch(`/api/uploads/${file.id}`, { method: 'DELETE' });
    setFiles((current) => current.filter((item) => item.key !== file.key && item.id !== file.id));
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (files.some((file) => file.status === 'uploading')) {
      setError('Wait for file uploads to finish.');
      return;
    }
    if (files.some((file) => file.status === 'error')) {
      setError('Remove files that failed to upload before submitting.');
      return;
    }
    setSaving(true);
    try {
      const response = await authFetch('/api/quote-requests', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          file_ids: files.filter((file) => file.id).map((file) => file.id),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to submit the quote request');
      onCreated(body.quote);
    } catch (err) {
      setError(err.message || 'Unable to submit the quote request');
      setSaving(false);
    }
  }

  return (
    <Box component="form" data-testid="quote-request-form" onSubmit={submit} sx={{ maxWidth: 840, mx: 'auto' }}>
      <PageTitle
        title="Request a Quote"
        subtitle="Tell Accent what you need. The request is saved as New until a manager sends a price."
      />
      {error ? <Alert severity="error" sx={{ mb: 2, '& .MuiAlert-message': { fontSize: '1.1rem' } }}>{error}</Alert> : null}
      <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderTop: `4px solid ${brand.orange}`, borderRadius: 1.5, p: { xs: 2, sm: 2.5 }, display: 'grid', gap: 2 }}>
        <TextField
          select
          label="Location for this request"
          required
          value={form.location_id}
          onChange={update('location_id')}
          data-testid="quote-location"
          helperText="Starts at your default shop. Pick another shop for this request only."
          sx={quoteFieldSx}
        >
          {locations.map((shop) => <MenuItem key={shop.id} value={String(shop.id)}>{shop.name}</MenuItem>)}
        </TextField>
        <TextField label="Project / job name" required value={form.project_name} onChange={update('project_name')} sx={quoteFieldSx} />
        <TextField label="Description / specs" required multiline minRows={4} value={form.description} onChange={update('description')} sx={quoteFieldSx} />
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
          <TextField label="Quantity" required value={form.quantity} onChange={update('quantity')} helperText="For example, 25 or 25 sets" sx={quoteFieldSx} />
          <TextField label="Size" value={form.size} onChange={update('size')} sx={quoteFieldSx} />
          <TextField label="Material / stock" value={form.material} onChange={update('material')} sx={quoteFieldSx} />
          <TextField label="Needed by" type="date" required value={form.needed_by} onChange={update('needed_by')} InputLabelProps={{ shrink: true }} sx={quoteFieldSx} />
        </Box>
        <TextField label="Finishing / notes" multiline minRows={3} value={form.finishing} onChange={update('finishing')} sx={quoteFieldSx} />
        <Box>
          <Typography sx={{ fontWeight: 800, fontSize: '1.15rem', mb: 1 }}>Files</Typography>
          <Typography sx={{ ...quoteBodySx, color: brand.muted, mb: 1 }}>
            Optional. Same file types and size limits as an order upload.
          </Typography>
          {files.map((file) => (
            <Box key={file.key || file.id} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'center', py: 0.75 }}>
              <Box>
                <Typography sx={{ fontSize: '1.1rem', overflowWrap: 'anywhere' }}>{file.original_name}</Typography>
                <Typography sx={{ color: file.status === 'error' ? brand.danger : brand.muted, fontSize: '1.02rem' }}>
                  {file.status === 'uploading' ? 'Uploading…' : file.status === 'error' ? (file.error || 'Upload failed') : formatFileSize(file.size_bytes)}
                </Typography>
              </Box>
              <Button type="button" onClick={() => removeFile(file)} sx={{ fontSize: '1.05rem', fontWeight: 700 }}>
                Remove
              </Button>
            </Box>
          ))}
          <Button type="button" component="label" variant="outlined" sx={{ mt: 1, fontSize: '1.05rem', fontWeight: 800, borderColor: brand.navy, color: brand.navy }}>
            Add files
            <input
              hidden
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg,.gif,.tif,.tiff,.webp,.bmp,.dwg,.zip,.plt"
              onChange={(event) => {
                const list = event.target.files;
                event.target.value = '';
                uploadFiles(list);
              }}
            />
          </Button>
        </Box>
        <Button type="submit" variant="contained" disabled={saving} sx={{ ...quotePrimaryButtonSx, bgcolor: brand.orange, color: '#111', '&:hover': { bgcolor: brand.orangeDark, color: '#fff' } }}>
          {saving ? 'Submitting…' : 'Submit request'}
        </Button>
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
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authFetch(`/api/quote-requests/${id}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load this quote');
        return body.quote;
      })
      .then((row) => {
        if (!cancelled) setQuote(row);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load this quote');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function decide(path) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await authFetch(`/api/quote-requests/${id}/${path}`, {
        method: 'POST',
        body: JSON.stringify(path === 'decline' ? { reason } : {}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to update this quote');
      setQuote(body.quote);
      setMessage(path === 'accept' ? 'You accepted this quote.' : 'You declined this quote.');
    } catch (err) {
      setError(err.message || 'Unable to update this quote');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState message="Loading quote..." />;
  if (error && !quote) return <ErrorState message={error} />;
  if (!quote) return null;

  return (
    <Box data-testid="customer-quote-detail" sx={{ maxWidth: 920, mx: 'auto' }}>
      <Button onClick={onBack} sx={{ fontSize: '1.05rem', fontWeight: 800, color: brand.navy, mb: 1 }}>
        Back to My Quotes
      </Button>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
        <Typography variant="h4" component="h1" sx={{ color: brand.navy, fontWeight: 800, fontSize: { xs: '1.9rem', sm: '2.15rem' } }}>
          {quote.project_name}
        </Typography>
        <QuoteStatusChip status={quote.status} />
      </Box>
      {message ? <Alert severity="success" sx={{ mb: 2, '& .MuiAlert-message': { fontSize: '1.1rem' } }}>{message}</Alert> : null}
      {error ? <Alert severity="error" sx={{ mb: 2, '& .MuiAlert-message': { fontSize: '1.1rem' } }}>{error}</Alert> : null}
      <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, p: { xs: 2, sm: 2.5 }, display: 'grid', gap: 1.5 }}>
        <Fact label="Description / specs" value={quote.description} />
        <Fact label="Quantity" value={quote.quantity} />
        <Fact label="Size" value={quote.size} />
        <Fact label="Material / stock" value={quote.material} />
        <Fact label="Finishing / notes" value={quote.finishing} />
        <Fact label="Needed by" value={quote.needed_by} />
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
        ) : null}
      </Box>
      {quote.status !== 'New' ? (
        <Box data-testid="customer-quote-offer" sx={{ mt: 2, bgcolor: '#fff', border: `1px solid ${brand.border}`, borderLeft: `4px solid ${brand.navy}`, borderRadius: 1.5, p: { xs: 2, sm: 2.5 } }}>
          <Typography sx={{ fontSize: '1.05rem', fontWeight: 800, color: brand.muted }}>Quote from Accent</Typography>
          <Typography data-testid="quote-price" sx={{ fontSize: '2rem', fontWeight: 800, color: brand.navy, mt: 0.5 }}>{money(quote) || '—'}</Typography>
          {quote.valid_until ? <Fact label="Valid until" value={quote.valid_until} /> : null}
          {quote.quote_notes ? <Fact label="Notes / terms" value={quote.quote_notes} /> : null}
          {quote.line_items?.length ? <LineTable lines={quote.line_items} /> : null}
          {quote.decline_reason ? <Fact label="Decline reason" value={quote.decline_reason} /> : null}
        </Box>
      ) : (
        <Typography sx={{ ...quoteBodySx, mt: 2, color: brand.muted }}>
          This request is New. The price will show here after Accent sends a quote.
        </Typography>
      )}
      {quote.status === 'Quoted' ? (
        <Box sx={{ mt: 2, display: 'grid', gap: 1.5 }}>
          <TextField
            label="Reason for declining (optional)"
            multiline
            minRows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            sx={quoteFieldSx}
          />
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <Button variant="contained" disabled={saving} onClick={() => decide('accept')} sx={{ ...quotePrimaryButtonSx, bgcolor: brand.green, '&:hover': { bgcolor: brand.greenDark } }}>
              Accept quote
            </Button>
            <Button variant="outlined" disabled={saving} onClick={() => decide('decline')} sx={{ ...quotePrimaryButtonSx, borderColor: brand.danger, color: brand.danger }}>
              Decline quote
            </Button>
          </Box>
        </Box>
      ) : null}
      <QuotePrintCredit />
    </Box>
  );
}

function LineTable({ lines }) {
  return (
    <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', mt: 1, '& th, & td': { textAlign: 'left', fontSize: '1.05rem', p: 1, borderBottom: `1px solid ${brand.border}` }, '& th': { color: '#fff', bgcolor: brand.navy, fontWeight: 800 } }}>
      <thead>
        <tr>
          <th>Code</th>
          <th>Unit</th>
          <th>Quantity</th>
          <th>Description</th>
          <th>Price</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.id || line.line_number}>
            <td>{line.code}</td>
            <td>{line.unit}</td>
            <td>{line.quantity}</td>
            <td>{line.description}</td>
            <td>{line.price ? `$${line.price}` : ''}</td>
          </tr>
        ))}
      </tbody>
    </Box>
  );
}
