import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  TextField,
  Typography,
} from '@mui/material';
import ProofPanel from '../components/ProofPanel';
import SectionCard from '../components/SectionCard';
import { authFetch } from '../api';
import { brand } from '../brand';

export default function SendProofPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  async function search(event) {
    event.preventDefault();
    const text = query.trim();
    if (!text) {
      setError('Enter an order number, company, or contact');
      return;
    }
    setSearching(true);
    setError('');
    try {
      const params = new URLSearchParams({ q: text, limit: '8', sort: 'created_at', dir: 'desc' });
      const response = await authFetch(`/api/search/orders?${params.toString()}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to search orders');
      setResults(body.orders || []);
      if (!(body.orders || []).length) setError('No orders matched that search.');
    } catch (err) {
      setError(err.message || 'Unable to search orders');
    } finally {
      setSearching(false);
    }
  }

  return (
    <Box sx={{ p: { xs: 1.5, sm: 3 }, maxWidth: 960, mx: 'auto' }}>
      <SectionCard
        title="Send Proof"
        subtitle="Upload a proof for an order or one of its work orders. The customer approves it or requests changes before the job is released to production."
      >
        <Box component="form" onSubmit={search} sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: '1fr auto' }, alignItems: 'start' }}>
          <TextField
            label="Find an order"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Order number, company, or contact"
            fullWidth
            data-testid="send-proof-search"
          />
          <Button type="submit" variant="contained" disabled={searching} sx={{ fontWeight: 800, bgcolor: brand.navy, height: 56, width: { xs: '100%', sm: 'auto' } }}>
            {searching ? 'Searching...' : 'Search'}
          </Button>
        </Box>
        {error ? <Alert severity="warning" sx={{ mt: 2 }}>{error}</Alert> : null}
        <Box sx={{ display: 'grid', gap: 1, mt: 2 }}>
          {results.map((order) => {
            const active = selected && selected.id === order.id;
            return (
              <Button
                key={order.id}
                onClick={() => setSelected(order)}
                variant={active ? 'contained' : 'outlined'}
                data-testid="send-proof-order"
                sx={{
                  justifyContent: 'flex-start',
                  textAlign: 'left',
                  textTransform: 'none',
                  px: 1.5,
                  py: 1,
                  borderColor: brand.border,
                  bgcolor: active ? brand.navy : '#fff',
                  color: active ? '#fff' : brand.text,
                  '&:hover': { bgcolor: active ? brand.navyDark : brand.page },
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 800, overflowWrap: 'anywhere' }}>{order.order_number}</Typography>
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere', color: active ? 'rgba(255,255,255,0.85)' : brand.muted }}>
                    {order.company || order.contact_name || 'Customer'}
                    {order.work_orders?.length ? ` · ${order.work_orders.map((row) => row.external_id).join(', ')}` : ''}
                  </Typography>
                </Box>
              </Button>
            );
          })}
        </Box>
      </SectionCard>
      {selected ? (
        <ProofPanel orderId={selected.id} canSend />
      ) : null}
    </Box>
  );
}
