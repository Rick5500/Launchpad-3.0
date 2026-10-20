import React, { useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { Alert, Box, Button, Typography } from '@mui/material';
import { authFetch } from '../api';
import { brand } from '../brand';
import FileTransferList from '../components/FileTransferList';
import Pager from '../components/Pager';
import { useAuth } from '../context/AuthContext';

export default function CustomerFiles() {
  const { id } = useParams();
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'manager' || user?.role === 'operator';
  const [payload, setPayload] = useState(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const limit = 20;

  async function load() {
    const path = id
      ? `/api/file-transfers/${encodeURIComponent(id)}`
      : `/api/file-transfers?limit=${limit}&offset=${offset}`;
    const response = await authFetch(path);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Unable to load files');
    setPayload(body);
    return body;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    load()
      .catch((err) => {
        if (!cancelled) {
          setPayload(null);
          setError(err.message || 'Unable to load files');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [id, offset]);

  const transfers = id
    ? (payload?.transfer ? [payload.transfer] : [])
    : (payload?.transfers || []);

  return (
    <Box data-testid="files-from-accent-page" sx={{ display: 'grid', gap: 2, minWidth: 0, maxWidth: 980 }}>
      <Box sx={{ bgcolor: '#fff', border: `1px solid ${brand.border}`, borderRadius: 1.5, overflow: 'hidden' }}>
        <Box sx={{ bgcolor: brand.navy, color: '#fff', px: 2, py: 1.25, borderBottom: `4px solid ${brand.orange}`, display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <Box>
            <Typography sx={{ fontWeight: 800 }}>Files from Accent</Typography>
            <Typography variant="body2" sx={{ opacity: 0.9 }}>
              {canManage ? 'Files sent to a customer.' : 'Files sent to you, including files from an order.'}
            </Typography>
          </Box>
          {id ? (
            <Button component={RouterLink} to="/files" color="inherit" sx={{ fontWeight: 700 }}>
              All files
            </Button>
          ) : null}
        </Box>
        <Box sx={{ p: { xs: 1.5, sm: 2 } }}>
          {loading ? <Typography color="text.secondary">Loading files...</Typography> : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
          {!loading && !error ? (
            <FileTransferList
              transfers={transfers}
              timeZone={payload?.timezone}
              canManage={canManage}
              highlightId={id}
              onChanged={load}
            />
          ) : null}
          {!id ? (
            <Pager
              offset={offset}
              limit={limit}
              total={payload?.total || 0}
              onChange={(next) => setOffset(next)}
            />
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
