import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Typography } from '@mui/material';
import ProofStatusChip from '../components/ProofStatusChip';
import SectionCard from '../components/SectionCard';
import LoadingState from '../components/LoadingState';
import ErrorState from '../components/ErrorState';
import { authFetch } from '../api';
import { brand, formatShopStamp } from '../brand';

export default function CustomerProofsPage() {
  const navigate = useNavigate();
  const [proofs, setProofs] = useState([]);
  const [timeZone, setTimeZone] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    authFetch('/api/proofs/pending')
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load proofs');
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setProofs(body.proofs || []);
        setTimeZone(body.timezone || '');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load proofs');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Box sx={{ p: { xs: 1.5, sm: 3 }, maxWidth: 880, mx: 'auto' }}>
      <Typography variant="h4" sx={{ color: brand.navy, fontWeight: 800, mb: 0.5 }}>Proofs</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Proofs waiting for your approval. Open one to view the files, approve it, or request changes.
      </Typography>
      {loading ? <LoadingState message="Loading proofs..." /> : null}
      {error ? <ErrorState message={error} /> : null}
      {!loading && !error && proofs.length === 0 ? (
        <SectionCard title="Nothing waiting" subtitle="When Accent sends a proof, it will show up here until you approve it or request changes." />
      ) : null}
      <Box sx={{ display: 'grid', gap: 1.5 }}>
        {proofs.map((proof) => (
          <Box
            key={proof.id}
            data-testid="pending-proof"
            sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderTop: `4px solid ${brand.orange}`, borderRadius: 1.5, p: { xs: 1.5, sm: 2 }, minWidth: 0 }}
          >
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
              <Typography sx={{ fontWeight: 800, color: brand.navy, overflowWrap: 'anywhere' }}>
                Order {proof.order_number} · {proof.version_label}
                {proof.work_order_number ? ` · ${proof.work_order_number}` : ''}
              </Typography>
              <ProofStatusChip status={proof.status} label={proof.status_label} />
            </Box>
            {proof.message ? (
              <Typography sx={{ mt: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{proof.message}</Typography>
            ) : null}
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
              {formatShopStamp(proof.created_at, timeZone) || proof.created_at}
              {proof.files?.length ? ` · ${proof.files.length} file${proof.files.length === 1 ? '' : 's'}` : ''}
            </Typography>
            <Button
              variant="contained"
              data-testid="open-pending-proof"
              onClick={() => navigate(`/orders/${proof.order_id}#proofs`)}
              sx={{ mt: 1.5, fontWeight: 800, bgcolor: brand.navy, width: { xs: '100%', sm: 'auto' } }}
            >
              Review proof
            </Button>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
