import React, { useEffect, useState } from 'react';
import { Alert, Box, Typography } from '@mui/material';
import LoadingState from '../components/LoadingState';
import { authFetch } from '../api';
import { brand } from '../brand';
import { useDocumentTitle } from '../useDocumentTitle';

export default function AccountAuditPage() {
  useDocumentTitle('Account audit');
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    authFetch('/api/account-audit')
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Unable to load the account audit log');
        return body;
      })
      .then((body) => {
        if (!cancelled) setEntries(body.entries || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load the account audit log');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <LoadingState />;

  return (
    <Box data-testid="account-audit-page">
      <Typography variant="h4" sx={{ color: brand.navy, fontWeight: 800, mb: 1 }}>Account audit</Typography>
      <Typography sx={{ color: brand.muted, mb: 2 }}>
        Welcome, set-password, and password-reset emails. Order mail stays on the order.
      </Typography>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {entries.length === 0 ? <Typography color="text.secondary">No account emails have been recorded.</Typography> : null}
      {entries.map((entry) => (
        <Box key={entry.id} sx={{ py: 1, borderBottom: `1px solid ${brand.border}` }}>
          <Typography sx={{ fontWeight: 700 }}>{entry.notice_type} · {entry.result}</Typography>
          <Typography variant="body2">
            {entry.recipient || 'no recipient'} · {entry.username || 'unknown account'} · {entry.created_at}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
